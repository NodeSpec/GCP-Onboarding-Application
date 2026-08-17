import { Timestamp } from '@google-cloud/firestore';
import { CredentialUnavailableError, credentialState } from '@lifecycle/shared';
import { WorkspaceError } from '../workspace/directoryClient.js';
import { logger } from '../logging.js';
import { NotificationError, type NotificationSender } from '../notify/sender.js';
import { renderWelcome } from '../notify/templates.js';
import { registerHandler, type StepContext, type StepResult } from '../steps/handler.js';

/**
 * Phase 2: tell the new person their account exists (REQ-004), and the resend
 * that reopens it when the first letter never landed (REQ-030).
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
 * Serves REQ-004 and REQ-030.
 */

/** How long a regenerated one-time password stays recoverable. */
const CREDENTIAL_TTL_HOURS = 72;

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
  /** Whether the operator asked for a fresh password (REQ-030 AC-4). */
  regenerate?: boolean;
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
 * The resend path when the operator did NOT ask for a new password (AC-3).
 *
 * Confirms a stored credential is still retrievable and points this request at
 * it, so an operator who retrieves against the resend gets the password the
 * account actually has. Without the pointer the handoff document would still be
 * keyed by the original create request and retrieval against the resend would
 * find nothing.
 *
 * Refusing when nothing is retrievable is the deliberate part. The letter tells
 * someone their account is ready and that a password is coming by another
 * channel; sending that when no password can be produced would tell them to
 * wait for something nobody can give them. The remedy is named in the error:
 * resubmit with regenerate=true.
 *
 * Worth being explicit about the cost: an operator who has already retrieved
 * the password and handed it over, and now only wants the letter re-sent,
 * cannot do that here. Their route is regenerate=true, which resets a password
 * the person may already be using.
 */
registerHandler({
  name: 'confirm-credential',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);

    if (ctx.step.credential) {
      return {
        status: 'skipped',
        output: { credentialRequestId: ctx.step.credential.credentialRequestId },
      };
    }

    const found = await ctx.credentials.currentFor(payload.primaryEmail);
    if (!found) {
      // Distinguishes "never stored" from "stored and gone". Both refuse, but
      // an operator chasing the first is looking at a different problem.
      throw new CredentialUnavailableError(payload.primaryEmail, 'missing');
    }

    const state = credentialState(found.record, Date.now());
    if (state !== 'valid') throw new CredentialUnavailableError(payload.primaryEmail, state);

    await ctx.store.recordCredential({
      requestId: ctx.request.requestId,
      stepId: ctx.step.stepId,
      targetUser: ctx.request.targetUser,
      record: {
        credentialRequestId: found.requestId,
        rotatedAt: null,
        supersededRequestId: null,
        keyVersion: found.record.keyVersion,
        expiresAt: found.record.expiresAt,
      },
      actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.request.requestedBy },
      action: 'credential.confirmed',
    });

    return {
      status: 'succeeded',
      output: {
        credentialRequestId: found.requestId,
        expiresAt: found.record.expiresAt.toDate().toISOString(),
      },
    };
  },
});

/**
 * Sets a fresh one-time password and invalidates the one it replaces (AC-4).
 *
 * ORDERING. The Workspace reset happens first, then the ciphertext is
 * committed. The reverse would store a password the account does not have if
 * the reset then failed, which is the worse of the two: an operator would hand
 * over a credential that does not sign in and have no way to tell. This way a
 * crash between the two leaves the account with a password nobody holds, and a
 * redelivery heals it by generating and setting another one, because a password
 * reset is idempotent by overwrite. The step is only unrecoverable once its
 * retry budget is spent, and the remedy then is another regeneration.
 *
 * A step that has already rotated short-circuits on its own record, so a
 * redelivery after the commit does not reset a password the operator may have
 * retrieved in the meantime.
 */
registerHandler({
  name: 'regenerate-credential',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);

    if (ctx.step.credential?.rotatedAt) {
      return {
        status: 'skipped',
        output: { credentialRequestId: ctx.step.credential.credentialRequestId, rotated: false },
      };
    }

    // Read before mutating, so the record being replaced is known and can be
    // invalidated in the same transaction as its replacement. Null is normal:
    // the usual reason to regenerate is that nothing usable is left.
    const superseded = await ctx.credentials.currentFor(payload.primaryEmail);

    // Lives in this scope and nowhere else. It goes to Workspace and to the
    // seal, and is never returned: step outputs are readable in the console and
    // mirrored to logs.
    let password: string | undefined = ctx.directory.generateInitialPassword();

    try {
      await ctx.directory.resetPassword(payload.primaryEmail, password);

      const handoff = await ctx.credentials.seal({
        primaryEmail: payload.primaryEmail,
        password,
        ttlHours: CREDENTIAL_TTL_HOURS,
      });

      await ctx.store.recordCredential({
        requestId: ctx.request.requestId,
        stepId: ctx.step.stepId,
        targetUser: ctx.request.targetUser,
        record: {
          credentialRequestId: ctx.request.requestId,
          rotatedAt: Timestamp.now(),
          supersededRequestId: superseded?.requestId ?? null,
          keyVersion: handoff.keyVersion,
          expiresAt: handoff.expiresAt,
        },
        rotation: { handoff, supersedes: superseded?.requestId ?? null },
        actor: { ...SYSTEM_ACTOR, onBehalfOf: ctx.request.requestedBy },
        action: 'credential.rotated',
      });

      return {
        status: 'succeeded',
        output: {
          credentialRequestId: ctx.request.requestId,
          supersededRequestId: superseded?.requestId ?? null,
          expiresAt: handoff.expiresAt.toDate().toISOString(),
        },
      };
    } finally {
      // Dropped as soon as the ciphertext is committed, so the plaintext is not
      // still reachable if this frame is captured later (REQ-019).
      password = undefined;
    }
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
