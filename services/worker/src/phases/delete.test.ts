import { Timestamp } from '@google-cloud/firestore';
import type { LifecycleRequest, LifecycleStep } from '@lifecycle/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * TC-REQ-006-1, -7 and -8: the offboarding handlers against a fake domain.
 *
 * The fake tracks suspension, memberships, tokens and Drive transfers, so a
 * replay is a real replay: a handler that acts twice and a handler that
 * correctly skips both look identical to a mock, and idempotence is most of
 * what this phase has to get right.
 *
 * The transfer cases are the ones worth reading. AC-8 says the transfer must be
 * CONFIRMED complete before deletion, and the failure mode it guards against is
 * silent: a transfer that is merely started before the account is deleted loses
 * the files, and every observable state looks fine until someone goes looking
 * for them.
 */

beforeAll(() => {
  Object.assign(process.env, {
    GCP_PROJECT_ID: 'company-project',
    TASKS_QUEUE: 'lifecycle-steps',
    TASKS_LOCATION: 'us-central1',
    WORKER_BASE_URL: 'https://lifecycle-worker.example.com',
    QUEUE_INVOKER_SA: 'queue@company-project.iam.gserviceaccount.com',
    API_SERVICE_SA: 'api@company-project.iam.gserviceaccount.com',
    SMTP_SENDER: 'noreply@company.com',
    SMTP_CREDENTIAL_SECRET: 'projects/1/secrets/smtp',
    CREDENTIAL_KEY_SECRET: 'projects/1/secrets/credkey',
    CONSOLE_BASE_URL: 'https://console.example.com',
  });
});

const { resolveHandler } = await import('../steps/handler.js');
const { UserNotFoundError, WorkspaceError } = await import('../workspace/directoryClient.js');
await import('./delete.js');

const TARGET = 'ada.lovelace@company.com';
const SUCCESSOR = 'grace.hopper@company.com';

interface FakeUser {
  id: string;
  primaryEmail: string;
  suspended: boolean;
}

/** An in-memory domain with the surface phase 4 uses. */
class FakeDomain {
  users = new Map<string, FakeUser>();
  memberships = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  failures = new Map<string, unknown>();

  /** Drive transfers, keyed by the leaver's user id. */
  transfers = new Map<string, { id: string; status: string }>();
  transferSeq = 0;

  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failures.has(op)) throw this.failures.get(op);
  }

  async getUser(primaryEmail: string) {
    this.maybeFail(`getUser:${primaryEmail}`);
    return this.users.get(primaryEmail) ?? null;
  }

  async setSuspended(primaryEmail: string, suspended: boolean) {
    this.maybeFail(`setSuspended:${primaryEmail}:${suspended}`);
    const user = this.users.get(primaryEmail);
    if (!user) throw { code: 404, message: 'Not found' };
    user.suspended = suspended;
  }

  async revokeTokens(primaryEmail: string) {
    this.maybeFail(`revokeTokens:${primaryEmail}`);
  }

  async listMemberships(memberEmail: string) {
    this.maybeFail(`listMemberships:${memberEmail}`);
    return [...this.memberships.entries()]
      .filter(([, members]) => members.has(memberEmail))
      .map(([group]) => group);
  }

  async removeMember(groupKey: string, memberEmail: string) {
    this.maybeFail(`removeMember:${groupKey}`);
    const removed = this.memberships.get(groupKey)?.delete(memberEmail) ?? false;
    return { removed };
  }

  async deleteUser(primaryEmail: string) {
    this.maybeFail(`deleteUser:${primaryEmail}`);
    const existed = this.users.delete(primaryEmail);
    return { deleted: existed };
  }

  async driveApplicationId() {
    this.maybeFail('driveApplicationId');
    return 'drive-and-docs';
  }

  async findDriveTransfer(oldOwnerUserId: string) {
    this.maybeFail(`findDriveTransfer:${oldOwnerUserId}`);
    return this.transfers.get(oldOwnerUserId) ?? null;
  }

  async startDriveTransfer(params: { oldOwnerUserId: string; newOwnerUserId: string }) {
    this.maybeFail(`startDriveTransfer:${params.oldOwnerUserId}`);
    this.transferSeq += 1;
    const record = { id: `transfer-${this.transferSeq}`, status: 'inProgress' };
    this.transfers.set(params.oldOwnerUserId, record);
    return record;
  }

  async driveTransferStatus(transferId: string) {
    this.maybeFail(`driveTransferStatus:${transferId}`);
    for (const record of this.transfers.values()) {
      if (record.id === transferId) return record.status;
    }
    return 'unknown';
  }

  countCalls(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

let domain: FakeDomain;

beforeEach(() => {
  domain = new FakeDomain();
  domain.users.set(TARGET, { id: 'id-leaver', primaryEmail: TARGET, suspended: false });
  domain.users.set(SUCCESSOR, { id: 'id-successor', primaryEmail: SUCCESSOR, suspended: false });
});

function context(options: { step?: Partial<LifecycleStep>; payload?: Record<string, unknown> }) {
  const request = {
    requestId: 'req-006',
    phase: 'delete',
    status: 'running',
    targetUser: TARGET,
    requestedBy: 'operator@company.com',
    payload: options.payload ?? { primaryEmail: TARGET },
    policySnapshot: {},
    computedDiff: null,
    holdUntil: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  } as unknown as LifecycleRequest;

  const step = {
    stepId: 'step-1',
    name: 'suspend-user',
    ordinal: 0,
    status: 'running',
    attempts: 1,
    requiresApproval: false,
    idempotencyKey: 'req-006:step-1:hash',
    input: {},
    output: null,
    error: null,
    approval: null,
    approverNotification: null,
    notification: null,
    credential: null,
    startedAt: null,
    completedAt: null,
    ...options.step,
  } as unknown as LifecycleStep;

  return {
    request,
    step,
    store: {} as never,
    directory: domain as never,
    credentials: {} as never,
  };
}

const run = (name: string, options: Parameters<typeof context>[0] = {}) =>
  resolveHandler(name).execute(context({ ...options, step: { name, ...options.step } }));

// ------------------------------------------------------------------- AC-2

describe('AC-2: suspension is the access cut, and it is reversible', () => {
  it('suspends an active account', async () => {
    const result = await run('suspend-user');

    expect(result.status).toBe('succeeded');
    expect(domain.users.get(TARGET)!.suspended).toBe(true);
  });

  it('skips an account that is already suspended', async () => {
    domain.users.get(TARGET)!.suspended = true;

    const result = await run('suspend-user');

    expect(result.status).toBe('skipped');
    expect(domain.countCalls('setSuspended')).toBe(0);
  });

  it('leaves the account intact: suspension deletes nothing', async () => {
    domain.memberships.set('platform@company.com', new Set([TARGET]));

    await run('suspend-user');

    // The account and its memberships are all still there. A request that
    // stops here is recoverable, which is the whole point of staging.
    expect(domain.users.has(TARGET)).toBe(true);
    expect(domain.memberships.get('platform@company.com')!.has(TARGET)).toBe(true);
    expect(domain.countCalls('deleteUser')).toBe(0);
    expect(domain.countCalls('removeMember')).toBe(0);
  });

  it('refuses to suspend an account that is not there', async () => {
    domain.users.delete(TARGET);

    await expect(run('suspend-user')).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

// ------------------------------------------------------------------- AC-1

describe('AC-1: revocation and membership removal', () => {
  it('revokes issued tokens', async () => {
    const result = await run('revoke-access');

    expect(result.status).toBe('succeeded');
    expect(domain.countCalls(`revokeTokens:${TARGET}`)).toBe(1);
  });

  it('removes every membership the account holds, without being told them', async () => {
    // The operator names no groups for an offboarding, and should not have to:
    // what is being removed is whatever the account happens to belong to.
    domain.memberships.set('platform@company.com', new Set([TARGET]));
    domain.memberships.set('oncall@company.com', new Set([TARGET, 'other@company.com']));

    const result = await run('remove-memberships');

    expect(result.status).toBe('succeeded');
    expect(result.output!.removed).toEqual(['platform@company.com', 'oncall@company.com']);
    expect(domain.memberships.get('oncall@company.com')!.has('other@company.com')).toBe(true);
  });

  it('skips when the account is already in no groups', async () => {
    const result = await run('remove-memberships');

    expect(result.status).toBe('skipped');
    expect(domain.countCalls('removeMember')).toBe(0);
  });

  it('is safe to replay: the second run finds nothing left and skips', async () => {
    domain.memberships.set('platform@company.com', new Set([TARGET]));

    expect((await run('remove-memberships')).status).toBe('succeeded');
    expect((await run('remove-memberships')).status).toBe('skipped');
    expect(domain.countCalls('removeMember')).toBe(1);
  });
});

// ------------------------------------------------------------------- AC-7

describe('AC-7: deletion is idempotent', () => {
  it('deletes an account that is present', async () => {
    const result = await run('delete-user');

    expect(result.status).toBe('succeeded');
    expect(domain.users.has(TARGET)).toBe(false);
  });

  it('resolves as satisfied when the account is already gone', async () => {
    // The most likely replay in the whole system: deletion is the last thing
    // that happens, so its acknowledgement is the most likely to be lost.
    domain.users.delete(TARGET);

    const result = await run('delete-user');

    expect(result.status).toBe('skipped');
    expect(result.output).toMatchObject({ reason: 'user already absent from the domain' });
  });

  it('does not fail a replay of its own successful run', async () => {
    expect((await run('delete-user')).status).toBe('succeeded');
    expect((await run('delete-user')).status).toBe('skipped');
  });
});

// ------------------------------------------------------------------- AC-8

describe('AC-8: the Drive transfer is confirmed complete before deletion', () => {
  const withSuccessor = {
    payload: { primaryEmail: TARGET, transferDriveTo: SUCCESSOR },
    step: { input: { successor: SUCCESSOR } },
  };

  it('starts a transfer and refuses to finish while it is in flight', async () => {
    // Retryable, not successful. A step that reported success here would let
    // the delete step dispatch behind a transfer still running, and deleting
    // the source account is what loses the files.
    const failing = run('transfer-drive', withSuccessor);

    await expect(failing).rejects.toBeInstanceOf(WorkspaceError);
    await expect(failing).rejects.toMatchObject({ errorClass: 'retryable' });
    expect(domain.countCalls('startDriveTransfer')).toBe(1);
  });

  it('succeeds once Workspace reports the transfer complete', async () => {
    await run('transfer-drive', withSuccessor).catch(() => undefined);
    domain.transfers.get('id-leaver')!.status = 'completed';

    const result = await run('transfer-drive', withSuccessor);

    expect(result.status).toBe('succeeded');
    expect(result.output).toMatchObject({ successor: SUCCESSOR, transferStatus: 'completed' });
  });

  it('reuses the transfer it already started rather than starting a second', async () => {
    // The API mints its own id, so there is no client-supplied key to
    // deduplicate on. A second transfer would duplicate the copy and could
    // still be running when the first finished.
    await run('transfer-drive', withSuccessor).catch(() => undefined);
    await run('transfer-drive', withSuccessor).catch(() => undefined);
    await run('transfer-drive', withSuccessor).catch(() => undefined);

    expect(domain.countCalls('startDriveTransfer')).toBe(1);
  });

  it('fails terminally when Workspace reports the transfer failed', async () => {
    await run('transfer-drive', withSuccessor).catch(() => undefined);
    domain.transfers.get('id-leaver')!.status = 'failed';

    const failing = run('transfer-drive', withSuccessor);

    await expect(failing).rejects.toMatchObject({ errorClass: 'terminal' });
  });

  it('refuses a successor who does not exist', async () => {
    // Worth failing on rather than deleting the account with the files still
    // attached to it.
    domain.users.delete(SUCCESSOR);

    await expect(run('transfer-drive', withSuccessor)).rejects.toBeInstanceOf(UserNotFoundError);
    expect(domain.countCalls('startDriveTransfer')).toBe(0);
  });

  it('refuses a transfer step carrying no successor', async () => {
    await expect(
      run('transfer-drive', { payload: { primaryEmail: TARGET }, step: { input: {} } }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });
});

// ------------------------------------------------------------------- AC-4

describe('the compensating step restores access', () => {
  it('unsuspends a suspended account', async () => {
    domain.users.get(TARGET)!.suspended = true;

    const result = await run('unsuspend-user');

    expect(result.status).toBe('succeeded');
    expect(domain.users.get(TARGET)!.suspended).toBe(false);
  });

  it('skips an account that is already active', async () => {
    const result = await run('unsuspend-user');

    expect(result.status).toBe('skipped');
    expect(domain.countCalls('setSuspended')).toBe(0);
  });

  it('fails when the account has already been deleted', async () => {
    // The cancellation cannot do what it promised. Reporting success here
    // would tell an operator the offboarding was called off when the account
    // was already gone.
    domain.users.delete(TARGET);

    await expect(run('unsuspend-user')).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
