import { Timestamp } from '@google-cloud/firestore';
import { isTerminalRequestStatus, type LifecycleStep, type LifecycleStore } from '@lifecycle/shared';
import { logger } from '../logging.js';
import type { TaskDispatcher } from '../tasks/dispatcher.js';

/**
 * What happens after a step finishes: work out the next step, and either
 * dispatch it or halt it for approval.
 *
 * The halt is the interesting case. A step that pauses for approval must have
 * its notification scheduled, or the request sits waiting for someone who was
 * never told, and REQ-002's expiry then rejects it for the wrong reason.
 *
 * A Cloud Tasks enqueue CANNOT join a Firestore transaction, so what happens
 * transactionally is the notification RECORD: it is written in the same
 * transaction as the status change, so a step cannot be committed as
 * awaiting_approval without its notification record. The record is the outbox
 * entry and the enqueue is the drain, which is why everything after the halt is
 * written to be safe to repeat: a redelivery that finds the halt already
 * applied still runs the enqueues rather than returning early, and every one of
 * them is idempotent (REQ-016 AC-7, REQ-032).
 *
 * Serves REQ-016 and REQ-032.
 */

const SYSTEM_ACTOR = { kind: 'system' as const, email: 'lifecycle-worker' };

export interface AdvanceDeps {
  store: LifecycleStore;
  dispatcher: TaskDispatcher;
}

/** Statuses that mean a step is done with and the plan may move past it. */
const FINISHED: readonly LifecycleStep['status'][] = ['succeeded', 'skipped'];

/**
 * The next step the plan is waiting on, whatever state it is in.
 *
 * Deliberately NOT "the next step still pending". Scanning for a pending step
 * skips over one that is halted in 'awaiting_approval', so a redelivered task
 * would walk straight past the halt and dispatch the step after it, executing
 * work the approver never released. Only a finished step may be stepped over;
 * anything else is the step the plan is at, and the caller decides what that
 * status means.
 */
function nextUnfinished(steps: LifecycleStep[], completedStepId: string): LifecycleStep | null {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const index = ordered.findIndex((step) => step.stepId === completedStepId);
  if (index === -1) return null;

  for (const candidate of ordered.slice(index + 1)) {
    if (!FINISHED.includes(candidate.status)) return candidate;
  }
  return null;
}

export async function advance(
  deps: AdvanceDeps,
  requestId: string,
  completedStepId: string,
): Promise<void> {
  const { store, dispatcher } = deps;

  const request = await store.getRequest(requestId);
  if (!request) return;

  // A terminal request dispatches nothing further. Without this an admin
  // cancelling a running request would stop the pending steps in the store but
  // not this code path: the step that was already executing would finish, reach
  // here, and release the next one, because the step transitions are guarded on
  // the STEP's status and know nothing about the request's (REQ-012 AC-5).
  if (isTerminalRequestStatus(request.status)) {
    logger.info({ requestId, status: request.status }, 'request is terminal, dispatching nothing');
    return;
  }

  const steps = await store.listSteps(requestId);
  const next = nextUnfinished(steps, completedStepId);

  // Nothing left unfinished: the plan is done.
  if (!next) {
    await store.transitionRequest({
      requestId,
      expectedFrom: ['running', 'awaiting_approval', 'held'],
      to: 'succeeded',
      audit: {
        actor: { ...SYSTEM_ACTOR, onBehalfOf: request.requestedBy },
        action: 'request.succeeded',
        targetUser: request.targetUser,
      },
    });
    logger.info({ requestId }, 'request complete');
    return;
  }

  const policy = request.policySnapshot[next.name];
  const requiresApproval = policy?.requiresApproval === true;
  const expiryHours = policy?.expiryHours;

  /**
   * Everything that follows a halt: move the request, notify, schedule the
   * expiry. Separated out because it runs on BOTH the delivery that performs
   * the halt and any redelivery that finds the halt already in place. Each part
   * is idempotent, so running it twice is harmless and never running it at all
   * is the failure worth guarding against.
   */
  const followHalt = async (step: LifecycleStep) => {
    await store.transitionRequest({
      requestId,
      expectedFrom: ['running', 'draft'],
      to: 'awaiting_approval',
      audit: {
        actor: { ...SYSTEM_ACTOR, onBehalfOf: request.requestedBy },
        action: 'request.awaiting_approval',
        targetUser: request.targetUser,
      },
    });

    await dispatcher.enqueueApproverNotification({ requestId, stepId: step.stepId });

    // Scheduled unconditionally: the expiry task is a no-op if the step has
    // been decided by the time it fires.
    if (expiryHours && expiryHours > 0) {
      await dispatcher.enqueueApprovalExpiry({
        requestId,
        stepId: step.stepId,
        fireAt: Timestamp.fromMillis(Date.now() + expiryHours * 3_600_000),
      });
    }

    logger.info({ requestId, stepId: step.stepId, expiryHours }, 'step halted for approval');
  };

  // The step is already halted, which means an earlier delivery performed the
  // halt and then died, or its enqueue failed. The notification record is still
  // outstanding, so drain it rather than returning: a halt nobody was told about
  // stalls the request until the expiry rejects it for the wrong reason.
  if (next.status === 'awaiting_approval') {
    await followHalt(next);
    return;
  }

  // Anything other than pending at this point belongs to another delivery:
  // 'ready' or 'running' means someone else is driving it, and a terminal
  // failure is handled where the failure happened.
  if (next.status !== 'pending') return;

  if (!requiresApproval) {
    const moved = await store.transitionStep({
      requestId,
      stepId: next.stepId,
      expectedFrom: 'pending',
      to: 'ready',
      audit: {
        actor: { ...SYSTEM_ACTOR, onBehalfOf: request.requestedBy },
        action: 'step.ready',
        targetUser: request.targetUser,
      },
    });

    // Another delivery got there first. It owns the dispatch.
    if (!moved.applied) return;

    await dispatcher.enqueueStep({
      requestId,
      stepId: next.stepId,
      idempotencyKey: next.idempotencyKey,
    });
    return;
  }

  // Halting for approval. The notification RECORD is written in the same
  // transaction as the status change; the enqueue is the drain of that record
  // and happens after. See the note at the top of the file.
  const halted = await store.transitionStep({
    requestId,
    stepId: next.stepId,
    expectedFrom: 'pending',
    to: 'awaiting_approval',
    audit: {
      actor: { ...SYSTEM_ACTOR, onBehalfOf: request.requestedBy },
      action: 'step.awaiting_approval',
      targetUser: request.targetUser,
      after: { step: next.name, approverRole: policy?.approverRole ?? 'approver', expiryHours: expiryHours ?? null },
    },
    patch: {
      approverNotification: { sentAt: null, recipients: [], deliveryId: null, error: null },
    },
  });

  // Lost the race to another delivery, and not to a halt: that delivery owns
  // whatever happens next.
  if (!halted.applied) return;

  await followHalt(next);
}
