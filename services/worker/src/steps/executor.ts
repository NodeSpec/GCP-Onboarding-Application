import type { LifecycleStep, LifecycleStore } from '@lifecycle/shared';
import type { CredentialStore } from '../credentials/credentialStore.js';
import { logger } from '../logging.js';
import { WorkspaceError } from '../workspace/directoryClient.js';
import type { DirectoryClient } from '../workspace/directoryClient.js';
import { resolveHandler, type StepContext } from './handler.js';

/**
 * The execution loop: one step per invocation.
 *
 * Cloud Tasks delivers at least once, so the first thing this does is try to
 * claim the step. If the claim does not apply, another delivery already has it
 * and this one is an acknowledged no-op. That claim, and every subsequent move,
 * carries its audit event in the same transaction because the store gives no
 * way to do otherwise.
 *
 * Two failure modes are handled explicitly rather than left to a sweep that
 * does not exist. An instance killed mid-step leaves its step 'running' with
 * nobody working on it; the claim reclaims that step once its lease expires
 * (REQ-016 AC-1). And Cloud Tasks stops delivering when its retry budget runs
 * out without telling anyone, so the last attempt settles the step and the
 * request itself rather than waiting for a signal that never comes (AC-5).
 *
 * The return value tells the route which HTTP status to send, which is how
 * Cloud Tasks learns whether to retry. Getting that mapping wrong is the
 * difference between a transient failure that heals and one that burns the
 * retry budget, so it is expressed as a type rather than left to the caller.
 *
 * Serves REQ-016 and REQ-013.
 */

export type ExecutionOutcome =
  /** Terminal for this attempt. Cloud Tasks must not retry. */
  | { kind: 'settled'; status: LifecycleStep['status'] }
  /** Duplicate delivery. Acknowledge without side effects. */
  | { kind: 'not-claimable'; observed: LifecycleStep['status'] }
  /** Transient. Cloud Tasks should retry with backoff. */
  | { kind: 'retry'; reason: string };

export interface ExecutorDeps {
  store: LifecycleStore;
  directory: DirectoryClient;
  credentials: CredentialStore;
  /** Enqueues the next step, or schedules the approval notice when it halts. */
  advance: (requestId: string, completedStepId: string) => Promise<void>;
  /**
   * How long a claim is honoured before another delivery may reclaim the step.
   * Must exceed the longest a step can legitimately take (REQ-016 AC-1).
   */
  leaseSeconds?: number;
  /**
   * The queue's retry budget. When the incoming attempt reaches it, a retryable
   * failure settles terminally instead of asking for another delivery, so a step
   * that exhausts its budget lands 'failed' with the request failed behind it
   * rather than sitting mid-flight forever (REQ-016 AC-5).
   */
  maxAttempts?: number;
}

const SYSTEM_ACTOR = { kind: 'system' as const, email: 'lifecycle-worker' };

/** Well above the longest a Workspace step should take. */
const DEFAULT_LEASE_SECONDS = 600;
/** Matches the queue's configured maxAttempts (REQ-021). */
const DEFAULT_MAX_ATTEMPTS = 5;

export async function executeStep(
  deps: ExecutorDeps,
  params: { requestId: string; stepId: string; attempt: number },
): Promise<ExecutionOutcome> {
  const { store, directory, credentials } = deps;
  const { requestId, stepId } = params;

  const request = await store.getRequest(requestId);
  if (!request) {
    // The request is gone. Retrying will not bring it back.
    return { kind: 'settled', status: 'failed' };
  }

  // Claim, guarded, with its audit event. Also reclaims a step left 'running'
  // by an instance that died mid-step, once its lease has expired.
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
    // Worth saying out loud: this step was abandoned mid-flight, so the handler
    // is about to re-run against a domain it may already have changed. That is
    // safe only because every handler reads before it mutates (REQ-013 AC-1).
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

    // Dispatch the next step, or halt it for approval. The halt and its
    // notification are enqueued together (REQ-032).
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
    // Hand the step back to 'ready' so the next delivery can CLAIM it. Failing
    // it here instead would wedge the step permanently: claiming requires
    // 'ready', so a step parked in 'failed' can never be picked up again, and
    // every transient Workspace error would be fatal in practice.
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

  // Either the error was terminal, or it was retryable and the budget is spent.
  // A budget-exhausted step must settle HERE: Cloud Tasks simply stops
  // delivering when it gives up and tells nobody, so waiting for a signal that
  // never comes would leave the request mid-flight forever (REQ-016 AC-5).
  const exhausted = retryable && !budgetLeft;
  const errorClass = exhausted
    ? 'retryable'
    : workspaceError?.errorClass === 'permission'
      ? 'permission'
      : 'terminal';

  await store.transitionStep({
    requestId: ctx.requestId,
    stepId: ctx.stepId,
    expectedFrom: 'running',
    to: 'failed',
    patch: {
      error: {
        class: errorClass,
        code: exhausted ? 'retry_budget_exhausted' : (workspaceError?.errorClass ?? 'unhandled'),
        message,
      },
    },
    audit: {
      actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.requestedBy },
      action: 'step.failed',
      targetUser: ctx.targetUser,
      outcome: 'failure',
      after: { error: message, attempt: ctx.attempt, maxAttempts, retryBudgetExhausted: exhausted },
    },
  });

  // A terminal step failure fails the request. No later step is dispatched.
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
