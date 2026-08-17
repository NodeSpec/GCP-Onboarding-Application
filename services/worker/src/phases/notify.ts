import { Timestamp } from '@google-cloud/firestore';
import { WorkspaceError } from '../workspace/directoryClient.js';
import { logger } from '../logging.js';
import { NotificationError, type NotificationSender } from '../notify/sender.js';
import { renderWelcome } from '../notify/templates.js';
import { registerHandler, type StepContext, type StepResult } from '../steps/handler.js';

/**
 * Phase 2: tell the new person their account exists (REQ-004).
 *
 * The letter goes to an OUT-OF-BAND address. The new mailbox is unreachable
 * until the account's first sign-in, so delivering there would mean sending the
 * sign-in instructions to a place that requires having already signed in.
 *
 * The letter carries no credential. The account is created with
 * changePasswordAtNextLogin=true and Google's own first-sign-in flow sets the
 * password, so this application hosts no password-setting page and no claim
 * link. That is what keeps every route behind IAP (REQ-007): a person being
 * onboarded is not an IAP principal and never interacts with this system.
 *
 * Serves REQ-004.
 */

/** The sender is injected once at startup; handlers are registered on import. */
let sender: NotificationSender | undefined;

export function useNotificationSender(next: NotificationSender): void {
  sender = next;
}

function requireSender(): NotificationSender {
  if (!sender) {
    throw new Error('No NotificationSender configured; call useNotificationSender at startup');
  }
  return sender;
}

interface NotifyPayload {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  /** Where the letter actually goes. Personal, or relayed by a manager. */
  notificationEmail: string;
}

function payloadOf(ctx: StepContext): NotifyPayload {
  return ctx.request.payload as unknown as NotifyPayload;
}

const SYSTEM_ACTOR = { kind: 'system' as const, email: 'lifecycle-worker' };

/**
 * Confirms the account exists and the notification address is usable, before
 * anything is sent. A letter about an account that is not there is worse than
 * no letter: it tells someone to sign in to nothing.
 */
registerHandler({
  name: 'validate-notify-request',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);

    if (!payload.notificationEmail) {
      throw new WorkspaceError(
        'no notification address on the request; the letter has nowhere to go',
        'terminal',
        undefined,
        'notify.validate',
      );
    }

    // Sending the letter to the new mailbox would be pointless: it cannot be
    // read until after the first sign-in the letter is explaining.
    if (payload.notificationEmail.toLowerCase() === payload.primaryEmail.toLowerCase()) {
      throw new WorkspaceError(
        'the notification address is the new primary mailbox, which cannot be read yet',
        'terminal',
        undefined,
        'notify.validate',
      );
    }

    const existing = await ctx.directory.getUser(payload.primaryEmail);
    if (!existing) {
      throw new WorkspaceError(
        `${payload.primaryEmail} does not exist; nothing to notify about`,
        'terminal',
        404,
        'notify.validate',
      );
    }

    return { status: 'succeeded', output: { notificationEmail: payload.notificationEmail } };
  },
});

/**
 * Renders and sends. Idempotent on the step's own delivery record: a replay
 * that finds a recorded delivery id returns without sending a second letter
 * (REQ-004 AC-3).
 *
 * The record is written the moment the provider accepts, BEFORE this returns,
 * so a crash between the send and the step settling cannot lose it. That
 * ordering is the whole of the idempotency guarantee: a delivery id recorded
 * only on success would be lost by exactly the failure it exists to survive.
 */
registerHandler({
  name: 'send-welcome-letter',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);

    if (ctx.step.notification?.deliveryId) {
      logger.info(
        { requestId: ctx.request.requestId, deliveryId: ctx.step.notification.deliveryId },
        'welcome letter already delivered, not sending again',
      );
      return {
        status: 'skipped',
        output: { deliveryId: ctx.step.notification.deliveryId, resent: false },
      };
    }

    const rendered = renderWelcome({
      givenName: payload.givenName,
      familyName: payload.familyName,
      primaryEmail: payload.primaryEmail,
    });

    const to = [payload.notificationEmail];

    try {
      const receipt = await requireSender().send({ ...rendered, to });

      await ctx.store.recordNotification({
        requestId: ctx.request.requestId,
        stepId: ctx.step.stepId,
        field: 'notification',
        record: {
          sentAt: Timestamp.now(),
          recipients: to,
          deliveryId: receipt.deliveryId,
          error: null,
        },
        actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.request.requestedBy },
        action: 'notification.sent',
      });

      return {
        status: 'succeeded',
        output: {
          deliveryId: receipt.deliveryId,
          template: rendered.version,
          // Recorded rather than papered over. With the Workspace SMTP relay
          // this is false, so 'sent' means 'accepted by the relay' and nothing
          // more; an unread letter has no remedy but REQ-030's resend.
          bounceReportingAvailable: receipt.bounceReportingAvailable,
        },
      };
    } catch (err) {
      // The provider refused. Record it on the step so an operator can see WHY
      // rather than finding a bare failure, then rethrow so the executor
      // classifies and settles it. Leaving the request resumable is the point:
      // silently succeeding here would mean nobody ever learns the new hire was
      // not told (REQ-004 AC-5).
      const message = err instanceof Error ? err.message : String(err);

      await ctx.store.recordNotification({
        requestId: ctx.request.requestId,
        stepId: ctx.step.stepId,
        field: 'notification',
        record: { sentAt: null, recipients: to, deliveryId: null, error: message },
        actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.request.requestedBy },
        action: 'notification.failed',
      });

      const retryable = err instanceof NotificationError ? err.retryable : false;
      throw new WorkspaceError(
        message,
        retryable ? 'retryable' : 'terminal',
        undefined,
        'notify.send',
        { cause: err },
      );
    }
  },
});
