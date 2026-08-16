import { config } from '../config.js';
import { WorkspaceError } from '../workspace/directoryClient.js';
import { registerHandler, type StepContext, type StepResult } from '../steps/handler.js';

/**
 * Phase 1: create the Workspace user, attribute it, and place it in groups.
 *
 * Every handler here reads live Workspace state before mutating and returns
 * `skipped` when the intended state already holds. That is not an optimisation.
 * Cloud Tasks delivers at least once, and a Directory call can time out on the
 * client after the change has landed on the server, so "already true" is a
 * normal condition rather than an error (REQ-013).
 *
 * Group assignment is one step per group so that a single failing group does
 * not discard the ones already applied (REQ-003).
 *
 * Serves REQ-003. Password generation and encryption is REQ-019 and lives in
 * the credential module; this phase asks for a password and never persists it.
 */

interface CreatePayload {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  orgUnitPath?: string;
  title?: string;
  department?: string;
  managerEmail?: string;
  groups?: string[];
}

function payloadOf(ctx: StepContext): CreatePayload {
  return ctx.request.payload as unknown as CreatePayload;
}

/**
 * Refuses a collision before anything is mutated. Without this the request
 * would fail partway through with an account already in existence, which is far
 * harder for an operator to reason about than a clean refusal (REQ-003).
 */
registerHandler({
  name: 'validate-request',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const existing = await ctx.directory.getUser(payload.primaryEmail);

    if (existing) {
      throw new WorkspaceError(
        `A user already exists with primary email ${payload.primaryEmail}`,
        'terminal',
        409,
        'validate-request',
      );
    }

    return { status: 'succeeded', output: { validated: payload.primaryEmail } };
  },
});

registerHandler({
  name: 'create-user',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);

    // Pre-mutation read. If a previous attempt created the account and then
    // timed out, this is where we notice rather than failing on AlreadyExists.
    const existing = await ctx.directory.getUser(payload.primaryEmail);
    if (existing) {
      return { status: 'skipped', output: { reason: 'user already exists', id: existing.id } };
    }

    // The generated password is handed straight to the credential module, which
    // encrypts it and stores ciphertext. It is never returned from this handler
    // and never written to a step output, because step outputs are readable in
    // the console and mirrored to logs.
    const password = await ctx.directory.generateInitialPassword();

    const created = await ctx.directory.insertUser({
      primaryEmail: payload.primaryEmail,
      name: { givenName: payload.givenName, familyName: payload.familyName },
      password,
      changePasswordAtNextLogin: true,
      orgUnitPath: payload.orgUnitPath ?? '/',
    });

    await ctx.directory.stashCredential(ctx.request.requestId, payload.primaryEmail, password);

    return { status: 'succeeded', output: { userId: created.id ?? null } };
  },
});

registerHandler({
  name: 'apply-attributes',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const user = await ctx.directory.getUser(payload.primaryEmail);
    if (!user) {
      throw new WorkspaceError(
        `User ${payload.primaryEmail} disappeared before attributes could be applied`,
        'terminal',
        404,
        'apply-attributes',
      );
    }

    const desired = {
      organizations: [
        { title: payload.title ?? null, department: payload.department ?? null, primary: true },
      ],
      relations: payload.managerEmail
        ? [{ value: payload.managerEmail, type: 'manager' }]
        : undefined,
    };

    const currentOrg = user.organizations?.[0] ?? {};
    const alreadyApplied =
      currentOrg.title === (payload.title ?? undefined) &&
      currentOrg.department === (payload.department ?? undefined);

    if (alreadyApplied) {
      return { status: 'skipped', output: { reason: 'attributes already match' } };
    }

    await ctx.directory.updateUser(payload.primaryEmail, desired);
    return { status: 'succeeded', output: { applied: Object.keys(desired) } };
  },
});

/**
 * One group per step. The group is carried on the step input rather than read
 * from the request payload, so each step is independently retryable and a
 * failure names exactly which group failed.
 */
registerHandler({
  name: 'assign-group',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const groupKey = ctx.step.input.groupKey as string | undefined;
    if (!groupKey) {
      throw new WorkspaceError('assign-group step has no groupKey on its input', 'terminal', 400, 'assign-group');
    }

    const isMember = await ctx.directory.hasMember(groupKey, payload.primaryEmail);
    if (isMember) {
      return { status: 'skipped', output: { group: groupKey, reason: 'already a member' } };
    }

    await ctx.directory.addMember(groupKey, payload.primaryEmail);
    return { status: 'succeeded', output: { group: groupKey } };
  },
});

/**
 * Reads the account and its memberships back and compares against intent. This
 * exists because every step above can legitimately return `skipped`, and a plan
 * made entirely of skips would otherwise report success without anyone having
 * confirmed the account is actually in the state that was asked for.
 */
registerHandler({
  name: 'verify-account',
  async execute(ctx: StepContext): Promise<StepResult> {
    const payload = payloadOf(ctx);
    const user = await ctx.directory.getUser(payload.primaryEmail);

    if (!user) {
      throw new WorkspaceError(
        `Verification failed: ${payload.primaryEmail} does not exist`,
        'terminal',
        404,
        'verify-account',
      );
    }

    const problems: string[] = [];
    const expectedOrgUnit = payload.orgUnitPath ?? '/';
    if (user.orgUnitPath !== expectedOrgUnit) {
      problems.push(`orgUnitPath is ${user.orgUnitPath}, expected ${expectedOrgUnit}`);
    }
    if (user.changePasswordAtNextLogin !== true) {
      problems.push('changePasswordAtNextLogin is not set');
    }

    for (const groupKey of payload.groups ?? []) {
      const isMember = await ctx.directory.hasMember(groupKey, payload.primaryEmail);
      if (!isMember) problems.push(`not a member of ${groupKey}`);
    }

    if (problems.length > 0) {
      throw new WorkspaceError(
        `Verification failed for ${payload.primaryEmail}: ${problems.join('; ')}`,
        'terminal',
        422,
        'verify-account',
      );
    }

    return {
      status: 'succeeded',
      output: { verified: true, customerId: config.WORKSPACE_CUSTOMER_ID },
    };
  },
});
