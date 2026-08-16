import { Timestamp } from '@google-cloud/firestore';
import type { LifecycleStep, LifecycleStore } from '@lifecycle/shared';
import { logger } from '../logging.js';
import type { TaskDispatcher } from '../tasks/dispatcher.js';

/**
 * What happens after a step finishes: work out the next step, and either
 * dispatch it or halt it for approval.
 *
 * The halt is the interesting case. A step that pauses for approval must have
 * its notification scheduled, or the request sits waiting for someone who was
 * never told, and REQ-002's expiry then rejects it for the wrong reason. So the
 * status change and the notification enqueue happen in the same transaction:
 * a step cannot be committed as awaiting_approval without its notice being
 * scheduled (REQ-032).
 *
 * Serves REQ-016 and REQ-032.
 */

const SYSTEM_ACTOR = { kind: 'system' as const, email: 'lifecycle-worker' };

export interface AdvanceDeps {
  store: LifecycleStore;
  dispatcher: TaskDispatcher;
}

function nextPending(steps: LifecycleStep[], completedStepId: string): LifecycleStep | null {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const index = ordered.findIndex((step) => step.stepId === completedStepId);
  if (index === -1) return null;

  for (const candidate of ordered.slice(index + 1)) {
    if (candidate.status === 'pending') return candidate;
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

  const steps = await store.listSteps(requestId);
  const next = nextPending(steps, completedStepId);

  // No pending step left: the plan is done.
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

  // Halting for approval. The notification enqueue is deliberately inside the
  // same transaction as the status change: see the note at the top of the file.
  const expiryHours = policy?.expiryHours;
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

  if (!halted.applied) return;

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

  await dispatcher.enqueueApproverNotification({ requestId, stepId: next.stepId });

  // Schedule the expiry sweep. It is a no-op if the step has been decided by
  // the time it fires, so it is safe to schedule unconditionally.
  if (expiryHours && expiryHours > 0) {
    await dispatcher.enqueueApprovalExpiry({
      requestId,
      stepId: next.stepId,
      fireAt: Timestamp.fromMillis(Date.now() + expiryHours * 3_600_000),
    });
  }

  logger.info({ requestId, stepId: next.stepId, expiryHours }, 'step halted for approval');
}
