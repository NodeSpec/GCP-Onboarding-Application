import { UserNotFoundError, WorkspaceError } from '../workspace/directoryClient.js';
import { registerHandler, type StepContext, type StepResult } from '../steps/handler.js';

/**
 * Phase 4: offboarding (REQ-006).
 *
 * Staged, and reversible until the last step. The ordering in the plan is the
 * safety property: suspension is the immediate access cut and the only move
 * that can be undone, so everything destructive happens behind it. A request
 * that stops anywhere before `delete-user` leaves an account that is suspended
 * but whole, which is a state an operator can recover from.
 *
 * Every handler reads live state before acting and reports 'skipped' when the
 * intended state already holds, as everywhere else in this system: Cloud Tasks
 * delivers at least once, and a step that ran and then timed out on the client
 * must be safe to replay (REQ-013).
 *
 * The compensating step at the bottom is what a cancellation becomes. It is not
 * part of the plan; the store appends it to a request already in flight,
 * because by then the account is suspended in Workspace and putting it back is
 * a mutation, and mutations only happen here.
 */

interface DeletePayload {
  primaryEmail: string;
  transferDriveTo?: string;
  holdHours?: number;
  reason?: string;
}

function payloadOf(ctx: StepContext): DeletePayload {
  return ctx.request.payload as unknown as DeletePayload;
}

/**
 * Cuts access immediately (AC-2).
 *
 * First in the plan, and first for a reason: everything after it is either
 * destructive or slow, and a leaver should stop being able to sign in at the
 * moment the request starts rather than when it finishes.
 */
registerHandler({
  name: 'suspend-user',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const user = await ctx.directory.getUser(payload.primaryEmail);

    if (!user) {
      throw new UserNotFoundError(payload.primaryEmail, 'suspend-user');
    }

    if (user.suspended === true) {
      return { status: 'skipped', output: { reason: 'already suspended' } };
    }

    await ctx.directory.setSuspended(payload.primaryEmail, true);
    return { status: 'succeeded', output: { suspended: true } };
  },
});

/**
 * Revokes issued OAuth tokens (AC-1).
 *
 * Suspension alone is not a session cut. A token issued before the suspension
 * keeps working against some surfaces, so an offboarding that stopped at
 * suspend would leave a leaver holding live credentials to the thing it just
 * locked them out of.
 *
 * Idempotent by construction: revoking a token that is already gone is not an
 * error, and the client's own list-then-delete resolves to nothing on a replay.
 */
registerHandler({
  name: 'revoke-access',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const user = await ctx.directory.getUser(payload.primaryEmail);

    if (!user) {
      throw new UserNotFoundError(payload.primaryEmail, 'revoke-access');
    }

    await ctx.directory.revokeTokens(payload.primaryEmail);
    return { status: 'succeeded', output: { tokensRevoked: true } };
  },
});

/**
 * Removes every group membership the account holds (AC-1).
 *
 * One step for all of them, unlike phases 1 and 3. Those act on groups an
 * operator named; this one acts on whatever the account happens to belong to,
 * which is not knowable at submission time and which nobody should have to
 * enumerate by hand in order to offboard a person.
 *
 * Discovering the list on each attempt is also what makes a replay safe: a
 * second run finds only what is left, and an account already out of everything
 * reports 'skipped'.
 */
registerHandler({
  name: 'remove-memberships',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const groups = await ctx.directory.listMemberships(payload.primaryEmail);

    if (groups.length === 0) {
      return { status: 'skipped', output: { reason: 'no remaining memberships' } };
    }

    const removed: string[] = [];
    for (const groupKey of groups) {
      const result = await ctx.directory.removeMember(groupKey, payload.primaryEmail);
      if (result.removed) removed.push(groupKey);
    }

    return { status: 'succeeded', output: { removed, considered: groups.length } };
  },
});

/**
 * Hands the leaver's Drive content to a named successor, and does not finish
 * until Workspace says the transfer is complete (AC-8).
 *
 * The waiting is the criterion. A transfer that is merely STARTED before the
 * account is deleted loses the files: deletion takes the source account with
 * it, and a transfer still in flight against a deleted owner does not finish.
 * So an in-flight transfer throws a RETRYABLE error, which hands the step back
 * to the queue and brings it round again rather than blocking a request thread
 * for what can be hours.
 *
 * Idempotency has no client-supplied key here: the Data Transfer API mints its
 * own id. So a replay looks for a transfer this system already started for the
 * account rather than starting a second one, which would duplicate the copy and
 * could still be running when the first completed.
 */
registerHandler({
  name: 'transfer-drive',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const successor = ctx.step.input.successor as string | undefined;
    if (!successor) {
      throw new WorkspaceError(
        'transfer-drive step has no successor on its input',
        'terminal',
        400,
        'transfer-drive',
      );
    }

    const [leaver, recipient] = await Promise.all([
      ctx.directory.getUser(payload.primaryEmail),
      ctx.directory.getUser(successor),
    ]);

    if (!leaver) throw new UserNotFoundError(payload.primaryEmail, 'transfer-drive');
    // A named successor who does not exist is the operator's mistake, and it is
    // worth failing on rather than deleting the account with the files still
    // attached to it.
    if (!recipient) throw new UserNotFoundError(successor, 'transfer-drive');

    const oldOwnerUserId = leaver.id;
    const newOwnerUserId = recipient.id;
    if (!oldOwnerUserId || !newOwnerUserId) {
      throw new WorkspaceError(
        'Workspace returned an account without an id, which a transfer cannot address',
        'retryable',
        undefined,
        'transfer-drive',
      );
    }

    const existing = await ctx.directory.findDriveTransfer(oldOwnerUserId);
    const transfer =
      existing ??
      (await ctx.directory.startDriveTransfer({
        oldOwnerUserId,
        newOwnerUserId,
        applicationId: await ctx.directory.driveApplicationId(),
      }));

    const status = existing
      ? await ctx.directory.driveTransferStatus(existing.id)
      : transfer.status;

    if (status === 'completed') {
      return {
        status: 'succeeded',
        output: { transferId: transfer.id, successor, transferStatus: status },
      };
    }

    if (status === 'failed') {
      throw new WorkspaceError(
        `Drive transfer ${transfer.id} from ${payload.primaryEmail} to ${successor} failed`,
        'terminal',
        undefined,
        'transfer-drive',
      );
    }

    // Still going. Retryable, so the queue brings this back on its own
    // schedule and the delete step behind it stays undispatched meanwhile.
    throw new WorkspaceError(
      `Drive transfer ${transfer.id} is ${status}; waiting for it to complete before deletion`,
      'retryable',
      undefined,
      'transfer-drive',
    );
  },
});

/**
 * Deletes the account. The irreversible step, and the reason this whole phase
 * is staged.
 *
 * Idempotent (AC-7): an account already absent means the intended state holds.
 * Failing there would wedge a request whose work is done, and would do it in
 * exactly the case a replay is most likely, since the delete is the last thing
 * that happens and the acknowledgement is the most likely thing to be lost.
 */
registerHandler({
  name: 'delete-user',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);

    const result = await ctx.directory.deleteUser(payload.primaryEmail);

    if (!result.deleted) {
      return { status: 'skipped', output: { reason: 'user already absent from the domain' } };
    }

    return { status: 'succeeded', output: { deleted: true, primaryEmail: payload.primaryEmail } };
  },
});

/**
 * The compensating step a cancellation becomes (AC-4, AC-5).
 *
 * Restores the access the offboarding took away. It is deliberately the ONLY
 * thing a cancellation does at the Workspace level: memberships removed earlier
 * in the plan are not put back, because this system does not know what the
 * membership list looked like before it started and inventing one would be
 * worse than leaving an operator to restore it deliberately. What this
 * guarantees is that the account can be signed into again, which is the thing
 * an operator cancelling an offboarding is actually asking for.
 *
 * When it succeeds, `advance` settles the request as 'cancelled' rather than
 * 'succeeded'. When it fails, the executor fails the request in the ordinary
 * way and the account stays suspended with the error recorded, which is
 * visibly wrong rather than silently wrong (AC-6).
 */
registerHandler({
  name: 'unsuspend-user',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const user = await ctx.directory.getUser(payload.primaryEmail);

    if (!user) {
      // The account is gone, so there is nothing to restore and the
      // cancellation cannot do what it promised. Failing is the honest
      // outcome: reporting 'cancelled' here would tell an operator the
      // offboarding was called off when the account had already been deleted.
      throw new UserNotFoundError(payload.primaryEmail, 'unsuspend-user');
    }

    if (user.suspended !== true) {
      return { status: 'skipped', output: { reason: 'account is already active' } };
    }

    await ctx.directory.setSuspended(payload.primaryEmail, false);
    return { status: 'succeeded', output: { suspended: false, restored: true } };
  },
});
