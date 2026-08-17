import type { RequestStatus, StepStatus } from './model.js';

/**
 * The transition guard.
 *
 * Cloud Tasks delivers at least once, so the same step can arrive twice and two
 * instances can race. The guard is what makes that safe: legal transitions are
 * declared here, and `assertStepTransition` is called inside the Firestore
 * transaction that performs the change, after re-reading current status. An
 * illegal move raises rather than mutating.
 *
 * Serves REQ-016.
 */

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: 'step' | 'request',
    readonly from: string,
    readonly to: string,
    readonly id: string,
  ) {
    super(`Illegal ${entity} transition for ${id}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  // Admission decides whether the first move is straight to ready, a pause for
  // approval, or a skip because the intended state already holds.
  pending: ['ready', 'awaiting_approval', 'skipped'],
  // An approval releases the step; a rejection terminates the request, which is
  // a request-level move, so the step itself stays put.
  awaiting_approval: ['ready', 'failed'],
  ready: ['running'],
  // Beyond the three outcomes, two moves exist for durability.
  //
  // 'ready' is the HAND-BACK: a retryable failure returns the step to the queue
  // rather than failing it. Without this a transient Workspace error left the
  // step 'failed', and since claiming requires 'ready', no redelivery could ever
  // pick it up again: every transient error was permanently fatal.
  //
  // 'running' is the STALE-LEASE RECLAIM, for an instance killed mid-step. It is
  // additionally gated on the lease having expired, checked inside the
  // transaction by LifecycleStore.claimStep, so a concurrent duplicate delivery
  // still cannot steal a live claim (REQ-016 AC-1).
  running: ['succeeded', 'failed', 'skipped', 'ready', 'running'],
  // An admin resume puts a failed step back in the queue.
  failed: ['ready'],
  succeeded: [],
  skipped: [],
};

const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  draft: ['running', 'awaiting_approval', 'cancelled'],
  running: ['awaiting_approval', 'held', 'succeeded', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'rejected', 'cancelled', 'failed'],
  held: ['running', 'cancelled', 'failed'],
  // Resume after failure.
  failed: ['running'],
  succeeded: [],
  rejected: [],
  cancelled: [],
};

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function assertStepTransition(stepId: string, from: StepStatus, to: StepStatus): void {
  if (!canTransitionStep(from, to)) {
    throw new InvalidTransitionError('step', from, to, stepId);
  }
}

export function assertRequestTransition(
  requestId: string,
  from: RequestStatus,
  to: RequestStatus,
): void {
  if (!canTransitionRequest(from, to)) {
    throw new InvalidTransitionError('request', from, to, requestId);
  }
}

/**
 * True when a step is claimable for execution. A redelivered task for a step
 * that is no longer `ready` is an acknowledged no-op, not an error: the first
 * delivery already did the work.
 */
export function isClaimable(status: StepStatus): boolean {
  return status === 'ready';
}
