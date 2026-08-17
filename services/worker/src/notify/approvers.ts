import { Timestamp } from '@google-cloud/firestore';
import {
  resolveStepPolicy,
  type LifecycleRequest,
  type LifecycleStep,
  type LifecycleStore,
  type OperatorRole,
} from '@lifecycle/shared';
import { config } from '../config.js';
import { logger } from '../logging.js';
import { NotificationError, type NotificationSender } from './sender.js';
import { consoleLinkFor, renderApproverNotice } from './templates.js';

/**
 * Telling the approvers a step is waiting for them (REQ-032).
 *
 * Without this, two-party approval is pull-only: a step halts and waits for
 * somebody to happen to look at the approvals inbox. Combined with REQ-002's
 * optional expiry, which auto-rejects on silence, an unnoticed request fails for
 * the wrong reason — nobody declined it, nobody knew.
 *
 * The worker sends because it holds the only SMTP credential. The API service
 * enqueues and never delivers, which is what keeps one delivery path and one
 * sender address for the whole system (AC-9).
 */

/** No approver holds the required role, so nobody can act. Never a silent pass. */
export class NoEligibleApproverError extends Error {
  constructor(
    readonly requestId: string,
    readonly stepId: string,
    readonly requiredRole: OperatorRole,
  ) {
    super(
      `Step ${stepId} of ${requestId} requires the '${requiredRole}' role to approve, but no ` +
        'eligible approver exists. The request will sit until it expires unless a binding is added.',
    );
    this.name = 'NoEligibleApproverError';
  }
}

export interface ApproverNotifierDeps {
  store: LifecycleStore;
  sender: NotificationSender;
  consoleBaseUrl?: string;
}

/**
 * Who may approve this step, from role bindings, against the request's
 * SNAPSHOTTED policy (AC-3).
 *
 * The snapshot is what makes this stable: an admin changing the policy after
 * the request was created must not change who is asked to approve work already
 * in flight, for the same reason the halt itself is decided from the snapshot.
 *
 * The requester is always excluded. REQ-002 forbids self-approval, so mailing
 * them would be inviting an action the server will refuse (AC-2).
 */
export async function eligibleApprovers(
  store: LifecycleStore,
  request: LifecycleRequest,
  step: LifecycleStep,
): Promise<{ recipients: string[]; requiredRole: OperatorRole }> {
  const policy = resolveStepPolicy(request.policySnapshot, step.name);
  const requiredRole: OperatorRole = policy.approverRole;

  const bindings = await store.listRoleBindings();
  const requester = request.requestedBy.toLowerCase();

  const recipients = bindings
    .filter((b) => b.roles.includes(requiredRole))
    // A group binding names a group address, not a person. Mailing the group is
    // the correct behaviour: whoever is in it receives it, which is exactly the
    // permission the binding grants.
    .map((b) => b.subject.toLowerCase())
    .filter((subject) => subject !== requester);

  return { recipients: [...new Set(recipients)].sort(), requiredRole };
}

/**
 * Sends the notice for one halted step. Idempotent on the step's own
 * approverNotification record: a redelivered task that finds a delivery id
 * returns without sending again (AC-4).
 *
 * A failure here must NOT fail the request. The step is still legitimately
 * awaiting approval; only the telling failed, and turning a mail outage into a
 * failed onboarding would be the wrong trade every time (AC-8).
 */
export async function notifyApprovers(
  deps: ApproverNotifierDeps,
  params: { requestId: string; stepId: string },
): Promise<{ sent: boolean; recipients: string[]; deliveryId: string | null }> {
  const { store, sender } = deps;

  const request = await store.getRequest(params.requestId);
  if (!request) {
    // Nothing to notify about, and no retry will bring it back.
    return { sent: false, recipients: [], deliveryId: null };
  }

  const step = (await store.listSteps(params.requestId)).find((s) => s.stepId === params.stepId);
  if (!step) return { sent: false, recipients: [], deliveryId: null };

  if (step.approverNotification?.deliveryId) {
    logger.info(
      { ...params, deliveryId: step.approverNotification.deliveryId },
      'approver notice already delivered, not sending again',
    );
    return {
      sent: false,
      recipients: step.approverNotification.recipients,
      deliveryId: step.approverNotification.deliveryId,
    };
  }

  // The step moved on between the halt and this task firing: approved,
  // rejected, or cancelled. Asking for a decision that has already been made
  // would be worse than saying nothing.
  if (step.status !== 'awaiting_approval') {
    logger.info({ ...params, observed: step.status }, 'step no longer awaiting approval, suppressing notice');
    await store.recordNotification({
      requestId: params.requestId,
      stepId: params.stepId,
      field: 'approverNotification',
      record: { sentAt: null, recipients: [], deliveryId: null, error: `suppressed: step is ${step.status}` },
      actor: { kind: 'system', email: 'lifecycle-worker' },
      action: 'notification.suppressed',
    });
    return { sent: false, recipients: [], deliveryId: null };
  }

  const { recipients, requiredRole } = await eligibleApprovers(store, request, step);

  if (recipients.length === 0) {
    // Loudly, not quietly. A request nobody can approve will sit until the
    // expiry rejects it, and the operator deserves to learn that now rather
    // than from a rejection nobody made (AC-7).
    await store.recordNotification({
      requestId: params.requestId,
      stepId: params.stepId,
      field: 'approverNotification',
      record: {
        sentAt: null,
        recipients: [],
        deliveryId: null,
        error: `no identity holds the '${requiredRole}' role`,
      },
      actor: { kind: 'system', email: 'lifecycle-worker' },
      action: 'notification.no_eligible_approver',
    });
    throw new NoEligibleApproverError(params.requestId, params.stepId, requiredRole);
  }

  const policy = resolveStepPolicy(request.policySnapshot, step.name);
  const deadline =
    policy.expiryHours && step.startedAt
      ? new Date(step.startedAt.toMillis() + policy.expiryHours * 3_600_000).toISOString()
      : undefined;

  const rendered = renderApproverNotice({
    requestId: request.requestId,
    phase: request.phase,
    targetUser: request.targetUser,
    requestedBy: request.requestedBy,
    ...(deadline === undefined ? {} : { deadline }),
    consoleUrl: consoleLinkFor(deps.consoleBaseUrl ?? config.CONSOLE_BASE_URL, request.requestId),
  });

  try {
    const receipt = await sender.send({ ...rendered, to: recipients });

    await store.recordNotification({
      requestId: params.requestId,
      stepId: params.stepId,
      field: 'approverNotification',
      record: {
        sentAt: Timestamp.now(),
        recipients,
        deliveryId: receipt.deliveryId,
        error: null,
      },
      actor: { kind: 'system', email: 'lifecycle-worker' },
      action: 'notification.sent',
    });

    return { sent: true, recipients, deliveryId: receipt.deliveryId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await store.recordNotification({
      requestId: params.requestId,
      stepId: params.stepId,
      field: 'approverNotification',
      record: { sentAt: null, recipients, deliveryId: null, error: message },
      actor: { kind: 'system', email: 'lifecycle-worker' },
      action: 'notification.failed',
    });

    // Rethrown so Cloud Tasks retries. The REQUEST is untouched: it is still
    // awaiting approval, which is the truth.
    throw err instanceof NotificationError ? err : new NotificationError(message, true, { cause: err });
  }
}
