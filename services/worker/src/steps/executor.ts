import {
  CredentialUnavailableError,
  type CredentialStore,
  type LifecycleStep,
  type LifecycleStore,
  type StepErrorClass,
} from '@lifecycle/shared';
import { logger } from '../logging.js';
import {
  UserAlreadyExistsError,
  UserNotFoundError,
  WorkspaceError,
} from '../workspace/directoryClient.js';
import type { DirectoryClient } from '../workspace/directoryClient.js';
import { resolveHandler, type StepContext } from './handler.js';

export type ExecutionOutcome =
  | { kind: 'settled'; status: LifecycleStep['status'] }
  | { kind: 'not-claimable'; observed: LifecycleStep['status'] }
  | { kind: 'retry'; reason: string };

export interface ExecutorDeps {
  store: LifecycleStore;
  directory: DirectoryClient;
  credentials: CredentialStore;
  advance: (requestId: string, completedStepId: string) => Promise<void>;
  leaseSeconds?: number;
  maxAttempts?: number;
}

const SYSTEM_ACTOR = { kind: 'system' as const, email: 'lifecycle-worker' };

const DEFAULT_LEASE_SECONDS = 600;
const DEFAULT_MAX_ATTEMPTS = 5;

export async function executeStep(
  deps: ExecutorDeps,
  params: { requestId: string; stepId: string; attempt: number },
): Promise<ExecutionOutcome> {
  const { store, directory, credentials } = deps;
  const { requestId, stepId } = params;

  const request = await store.getRequest(requestId);
  if (!request) {
    return { kind: 'settled', status: 'failed' };
  }

  const claim = await store.claimStep({
    requestId,
    stepId,
    attempt: params.attempt,
    leaseSeconds: deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    audit: {
      actor: { ...SYSTEM_ACTOR, onBehalfOf: request.requestedBy },
      action: 'step.claim',
      targetUser: request.targetUser,
    },
  });

  if (!claim.claimed) {
    logger.info({ requestId, stepId, observed: claim.observed }, 'step not claimable, acknowledging');
    return { kind: 'not-claimable', observed: claim.observed };
  }

  if (claim.reclaimed) {
    logger.warn({ requestId, stepId }, 'reclaimed a step whose lease expired; replaying it');
  }

  const steps = await store.listSteps(requestId);
  const step = steps.find((s) => s.stepId === stepId);
  if (!step) return { kind: 'settled', status: 'failed' };

  const ctx: StepContext = { request, step, store, directory, credentials };

  try {
    const handler = resolveHandler(step.name);
    const result = await handler.execute(ctx);

    await store.transitionStep({
      requestId,
      stepId,
      expectedFrom: 'running',
      to: result.status,
      patch: { output: result.output ?? null, error: null },
      audit: {
        actor: { ...SYSTEM_ACTOR, onBehalfOf: request.requestedBy },
        action: `step.${result.status}`,
        targetUser: request.targetUser,
        after: { step: step.name, output: result.output ?? null },
      },
    });

    await deps.advance(requestId, stepId);

    return { kind: 'settled', status: result.status };
  } catch (err) {
    return settleFailure(
      deps,
      {
        requestId,
        stepId,
        step,
        targetUser: request.targetUser,
        requestedBy: request.requestedBy,
        attempt: params.attempt,
      },
      err,
    );
  }
}

function classifyFailure(err: unknown, exhausted: boolean): { class: StepErrorClass; code: string } {
  if (exhausted) return { class: 'retryable', code: 'retry_budget_exhausted' };

  if (err instanceof UserAlreadyExistsError) return { class: 'validation', code: 'already_exists' };

  if (err instanceof UserNotFoundError) return { class: 'validation', code: 'user_not_found' };

  if (err instanceof CredentialUnavailableError) {
    return { class: 'terminal', code: 'credential_unavailable' };
  }

  if (err instanceof WorkspaceError) {
    const permission = err.errorClass === 'permission';
    return { class: permission ? 'permission' : 'terminal', code: err.errorClass };
  }

  return { class: 'terminal', code: 'unhandled' };
}

async function settleFailure(
  deps: ExecutorDeps,
  ctx: {
    requestId: string;
    stepId: string;
    step: LifecycleStep;
    targetUser: string;
    requestedBy: string;
    attempt: number;
  },
  err: unknown,
): Promise<ExecutionOutcome> {
  const { store } = deps;
  const workspaceError = err instanceof WorkspaceError ? err : null;
  const retryable = workspaceError ? workspaceError.errorClass === 'retryable' : false;
  const message = err instanceof Error ? err.message : String(err);
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const budgetLeft = retryable && ctx.attempt < maxAttempts;

  if (budgetLeft) {
    await store.transitionStep({
      requestId: ctx.requestId,
      stepId: ctx.stepId,
      expectedFrom: 'running',
      to: 'ready',
      patch: { error: { class: 'retryable', code: 'workspace_retryable', message } },
      audit: {
        actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.requestedBy },
        action: 'step.attempt_failed',
        targetUser: ctx.targetUser,
        outcome: 'failure',
        after: { error: message, attempt: ctx.attempt, maxAttempts },
      },
    });
    logger.warn(
      { requestId: ctx.requestId, stepId: ctx.stepId, attempt: ctx.attempt, err: message },
      'retryable step failure, asking Cloud Tasks to redeliver',
    );
    return { kind: 'retry', reason: message };
  }

  const exhausted = retryable && !budgetLeft;
  const { class: errorClass, code } = classifyFailure(err, exhausted);

  await store.transitionStep({
    requestId: ctx.requestId,
    stepId: ctx.stepId,
    expectedFrom: 'running',
    to: 'failed',
    patch: {
      error: { class: errorClass, code, message },
    },
    audit: {
      actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.requestedBy },
      action: 'step.failed',
      targetUser: ctx.targetUser,
      outcome: 'failure',
      after: { error: message, attempt: ctx.attempt, maxAttempts, retryBudgetExhausted: exhausted },
    },
  });

  await store.transitionRequest({
    requestId: ctx.requestId,
    expectedFrom: ['running', 'awaiting_approval', 'held'],
    to: 'failed',
    audit: {
      actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.requestedBy },
      action: 'request.failed',
      targetUser: ctx.targetUser,
      outcome: 'failure',
      after: { failedStep: ctx.step.name, error: message },
    },
  });

  logger.error(
    { requestId: ctx.requestId, stepId: ctx.stepId, exhausted, err: message },
    exhausted ? 'retry budget exhausted, request failed' : 'terminal step failure, request failed',
  );
  return { kind: 'settled', status: 'failed' };
}
