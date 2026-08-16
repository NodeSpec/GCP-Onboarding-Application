import type { LifecycleStep, LifecycleStore } from '@lifecycle/shared';
import { logger } from '../logging.js';
import { WorkspaceError } from '../workspace/directoryClient.js';
import type { DirectoryClient } from '../workspace/directoryClient.js';
import { resolveHandler, type StepContext } from './handler.js';

/**
 * The execution loop: one step per invocation.
 *
 * Cloud Tasks delivers at least once, so the first thing this does is try to
 * claim the step by moving it ready -> running with `expectedFrom: ready`. If
 * the claim does not apply, another delivery already has it and this one is an
 * acknowledged no-op. That claim, and every subsequent move, carries its audit
 * event in the same transaction because the store gives no way to do otherwise.
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
  /** Enqueues the next step, or schedules the approval notice when it halts. */
  advance: (requestId: string, completedStepId: string) => Promise<void>;
}

const SYSTEM_ACTOR = { kind: 'system' as const, email: 'lifecycle-worker' };

export async function executeStep(
  deps: ExecutorDeps,
  params: { requestId: string; stepId: string; attempt: number },
): Promise<ExecutionOutcome> {
  const { store, directory } = deps;
  const { requestId, stepId } = params;

  const request = await store.getRequest(requestId);
  if (!request) {
    // The request is gone. Retrying will not bring it back.
    return { kind: 'settled', status: 'failed' };
  }

  // Claim. ready -> running, guarded, with its audit event.
  const claim = await store.transitionStep({
    requestId,
    stepId,
    expectedFrom: 'ready',
    to: 'running',
    patch: { attempts: params.attempt },
    audit: {
      actor: { ...SYSTEM_ACTOR, onBehalfOf: request.requestedBy },
      action: 'step.claim',
      targetUser: request.targetUser,
    },
  });

  if (!claim.applied) {
    logger.info({ requestId, stepId, observed: claim.observed }, 'step not claimable, acknowledging');
    return { kind: 'not-claimable', observed: claim.observed };
  }

  const steps = await store.listSteps(requestId);
  const step = steps.find((s) => s.stepId === stepId);
  if (!step) return { kind: 'settled', status: 'failed' };

  const ctx: StepContext = { request, step, store, directory };

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
    return settleFailure(deps, { requestId, stepId, step, targetUser: request.targetUser, requestedBy: request.requestedBy }, err);
  }
}

async function settleFailure(
  deps: ExecutorDeps,
  ctx: { requestId: string; stepId: string; step: LifecycleStep; targetUser: string; requestedBy: string },
  err: unknown,
): Promise<ExecutionOutcome> {
  const { store } = deps;
  const workspaceError = err instanceof WorkspaceError ? err : null;
  const retryable = workspaceError ? workspaceError.errorClass === 'retryable' : false;
  const message = err instanceof Error ? err.message : String(err);

  if (retryable) {
    // Hand the step back so the next delivery can claim it. The step stays
    // alive; Cloud Tasks owns the backoff and the attempt budget, and when that
    // budget is exhausted the queue stops delivering and the step is left
    // failed by the sweep rather than by a guess made here.
    await store.transitionStep({
      requestId: ctx.requestId,
      stepId: ctx.stepId,
      expectedFrom: 'running',
      to: 'failed',
      patch: { error: { class: 'retryable', code: 'workspace_retryable', message } },
      audit: {
        actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.requestedBy },
        action: 'step.attempt_failed',
        targetUser: ctx.targetUser,
        outcome: 'failure',
        after: { error: message },
      },
    });
    logger.warn({ ...ctx, err: message }, 'retryable step failure, asking Cloud Tasks to redeliver');
    return { kind: 'retry', reason: message };
  }

  const errorClass = workspaceError?.errorClass === 'permission' ? 'permission' : 'terminal';

  await store.transitionStep({
    requestId: ctx.requestId,
    stepId: ctx.stepId,
    expectedFrom: 'running',
    to: 'failed',
    patch: { error: { class: errorClass, code: workspaceError?.errorClass ?? 'unhandled', message } },
    audit: {
      actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.requestedBy },
      action: 'step.failed',
      targetUser: ctx.targetUser,
      outcome: 'failure',
      after: { error: message },
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

  logger.error({ ...ctx, err: message }, 'terminal step failure, request failed');
  return { kind: 'settled', status: 'failed' };
}
