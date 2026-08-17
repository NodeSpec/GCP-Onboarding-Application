import { Timestamp } from '@google-cloud/firestore';
import type { LifecycleRequest, LifecycleStep } from '@lifecycle/shared';
import type { admin_directory_v1 } from 'googleapis';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * TC-REQ-003-1 through TC-REQ-003-6, plus TC-REQ-013-1 and TC-REQ-013-5.
 *
 * The handlers run for real against a fake Workspace domain. The fake holds
 * users and memberships in memory and answers the same questions the Directory
 * API answers, so replaying a step against a domain where the change already
 * holds is a real replay rather than a mocked one. That is the only way to
 * observe the skip behaviour REQ-013 is about: a handler that mutates twice and
 * a handler that correctly skips both return success to a mock.
 */

// Configuration is read lazily, so this only has to be in place before the
// first property access. verify-account reads WORKSPACE_CUSTOMER_ID.
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
const { WorkspaceError } = await import('../workspace/directoryClient.js');
await import('./create.js');

type User = admin_directory_v1.Schema$User;

/** An in-memory Workspace domain with the surface the phase handlers use. */
class FakeDomain {
  users = new Map<string, User>();
  memberships = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  /** Set to make the next call of that name throw. */
  failures = new Map<string, unknown>();

  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failures.has(op)) {
      const err = this.failures.get(op);
      this.failures.delete(op);
      throw err;
    }
  }

  async getUser(primaryEmail: string): Promise<User | null> {
    this.maybeFail(`getUser:${primaryEmail}`);
    return this.users.get(primaryEmail.toLowerCase()) ?? null;
  }

  async insertUser(input: {
    primaryEmail: string;
    name: { givenName: string; familyName: string };
    password: string;
    changePasswordAtNextLogin: boolean;
    orgUnitPath: string;
  }): Promise<User> {
    this.maybeFail(`insertUser:${input.primaryEmail}`);
    const key = input.primaryEmail.toLowerCase();
    if (this.users.has(key)) {
      throw { code: 409, message: 'Entity already exists' };
    }
    const user: User = {
      id: `id-${this.users.size + 1}`,
      primaryEmail: input.primaryEmail,
      name: { givenName: input.name.givenName, familyName: input.name.familyName },
      orgUnitPath: input.orgUnitPath,
      changePasswordAtNextLogin: input.changePasswordAtNextLogin,
    };
    this.users.set(key, user);
    return user;
  }

  async updateUser(primaryEmail: string, patch: Record<string, unknown>): Promise<void> {
    this.maybeFail(`updateUser:${primaryEmail}`);
    const user = this.users.get(primaryEmail.toLowerCase());
    if (!user) throw { code: 404, message: 'Not found' };
    Object.assign(user, patch);
  }

  async hasMember(groupKey: string, memberEmail: string): Promise<boolean> {
    this.maybeFail(`hasMember:${groupKey}`);
    return this.memberships.get(groupKey)?.has(memberEmail.toLowerCase()) ?? false;
  }

  async addMember(groupKey: string, memberEmail: string): Promise<void> {
    this.maybeFail(`addMember:${groupKey}`);
    const set = this.memberships.get(groupKey) ?? new Set<string>();
    set.add(memberEmail.toLowerCase());
    this.memberships.set(groupKey, set);
  }

  generateInitialPassword(): string {
    return `Generated-${this.users.size}-Aa1!xyzXYZ098`;
  }

  countCalls(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

/** Records what was stashed so the plaintext handling can be inspected. */
class FakeCredentials {
  readonly stashed: { requestId: string; primaryEmail: string; password: string; ttlHours: number }[] = [];
  async stash(params: { requestId: string; primaryEmail: string; password: string; ttlHours: number }) {
    this.stashed.push({ ...params });
  }
}

const PAYLOAD = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  orgUnitPath: '/Engineering',
  title: 'Staff Engineer',
  department: 'Platform',
  managerEmail: 'grace.hopper@company.com',
  groups: ['engineering@company.com', 'platform@company.com'],
};

let domain: FakeDomain;
let credentials: FakeCredentials;

beforeEach(() => {
  domain = new FakeDomain();
  credentials = new FakeCredentials();
});

function context(overrides: { step?: Partial<LifecycleStep>; payload?: Record<string, unknown> } = {}) {
  const request = {
    requestId: 'req-001',
    phase: 'create',
    status: 'running',
    targetUser: PAYLOAD.primaryEmail,
    requestedBy: 'operator@company.com',
    payload: overrides.payload ?? PAYLOAD,
    policySnapshot: {},
    computedDiff: null,
    holdUntil: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  } as unknown as LifecycleRequest;

  const step = {
    stepId: 'step-1',
    name: 'create-user',
    ordinal: 0,
    status: 'running',
    attempts: 1,
    requiresApproval: false,
    idempotencyKey: 'req-001:step-1:hash',
    input: {},
    output: null,
    error: null,
    approval: null,
    approverNotification: null,
    startedAt: null,
    completedAt: null,
    ...overrides.step,
  } as unknown as LifecycleStep;

  return {
    request,
    step,
    store: {} as never,
    directory: domain as never,
    credentials: credentials as never,
  };
}

const run = (name: string, overrides = {}) => resolveHandler(name).execute(context(overrides) as never);

/** Drives the whole phase in order, one group step per group. */
async function runPhase(payload: Record<string, unknown> = PAYLOAD) {
  await run('validate-request', { payload });
  await run('create-user', { payload });
  await run('apply-attributes', { payload });
  for (const groupKey of (payload.groups as string[]) ?? []) {
    await run('assign-group', { payload, step: { input: { groupKey } } });
  }
  return run('verify-account', { payload });
}

describe('AC-1: a valid creation request produces a matching Workspace user', () => {
  it('creates the user with the requested email, names and org unit', async () => {
    await run('create-user');

    const user = domain.users.get(PAYLOAD.primaryEmail);
    expect(user).toBeDefined();
    expect(user!.primaryEmail).toBe(PAYLOAD.primaryEmail);
    expect(user!.name).toMatchObject({ givenName: 'Ada', familyName: 'Lovelace' });
    expect(user!.orgUnitPath).toBe('/Engineering');
  });

  it('defaults the org unit to the domain root when none is requested', async () => {
    const { orgUnitPath: _omitted, ...withoutOrgUnit } = PAYLOAD;
    await run('create-user', { payload: withoutOrgUnit });

    expect(domain.users.get(PAYLOAD.primaryEmail)!.orgUnitPath).toBe('/');
  });

  it('applies the requested title and department', async () => {
    await run('create-user');
    await run('apply-attributes');

    const user = domain.users.get(PAYLOAD.primaryEmail) as Record<string, unknown>;
    expect(user.organizations).toEqual([
      { title: 'Staff Engineer', department: 'Platform', primary: true },
    ]);
    expect(user.relations).toEqual([{ value: PAYLOAD.managerEmail, type: 'manager' }]);
  });
});

describe('AC-2: every requested group appears in the membership list', () => {
  it('adds the user to each group in the request', async () => {
    await runPhase();

    for (const groupKey of PAYLOAD.groups) {
      expect(await domain.hasMember(groupKey, PAYLOAD.primaryEmail)).toBe(true);
    }
  });

  it('adds the user to no group that was not requested', async () => {
    await runPhase();

    expect([...domain.memberships.keys()].sort()).toEqual([...PAYLOAD.groups].sort());
  });
});

describe('AC-3: a colliding primary email fails before any mutation', () => {
  it('refuses at validation with a terminal error naming the collision', async () => {
    domain.users.set(PAYLOAD.primaryEmail, { id: 'existing', primaryEmail: PAYLOAD.primaryEmail });

    const failing = run('validate-request');
    await expect(failing).rejects.toBeInstanceOf(WorkspaceError);
    await expect(failing).rejects.toMatchObject({ errorClass: 'terminal', status: 409 });
    await expect(failing).rejects.toThrow(PAYLOAD.primaryEmail);
  });

  it('attempts no mutation when validation refuses', async () => {
    domain.users.set(PAYLOAD.primaryEmail, { id: 'existing', primaryEmail: PAYLOAD.primaryEmail });

    await run('validate-request').catch(() => undefined);

    expect(domain.countCalls('insertUser')).toBe(0);
    expect(domain.countCalls('updateUser')).toBe(0);
    expect(domain.countCalls('addMember')).toBe(0);
  });
});

describe('AC-4: the account is created with a forced password change', () => {
  it('sets changePasswordAtNextLogin', async () => {
    await run('create-user');
    expect(domain.users.get(PAYLOAD.primaryEmail)!.changePasswordAtNextLogin).toBe(true);
  });

  it('hands the generated password to the credential store and returns it to no one', async () => {
    const result = await run('create-user');

    expect(credentials.stashed).toHaveLength(1);
    expect(credentials.stashed[0].password).toBeTruthy();
    expect(credentials.stashed[0].requestId).toBe('req-001');
    expect(credentials.stashed[0].ttlHours).toBeGreaterThan(0);

    // The step output is readable in the console and mirrored to logs, so the
    // password must not be anywhere in it.
    expect(JSON.stringify(result)).not.toContain(credentials.stashed[0].password);
  });

  it('generates a password meeting the configured length and complexity policy', async () => {
    await run('create-user');
    const password = credentials.stashed[0].password;

    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
  });
});

describe('AC-5: a failing group assignment retains the groups already applied', () => {
  it('keeps the successful group, reports the failing one, and does not report success', async () => {
    await run('validate-request');
    await run('create-user');

    const [first, second] = PAYLOAD.groups;
    await run('assign-group', { step: { input: { groupKey: first } } });

    domain.failures.set(`addMember:${second}`, { code: 400, message: 'group does not exist' });
    const failing = run('assign-group', { step: { input: { groupKey: second } } });

    await expect(failing).rejects.toMatchObject({ code: 400 });
    expect(await domain.hasMember(first, PAYLOAD.primaryEmail)).toBe(true);
    expect(await domain.hasMember(second, PAYLOAD.primaryEmail)).toBe(false);
  });

  it('refuses an assign-group step that carries no group on its input', async () => {
    const failing = run('assign-group', { step: { input: {} } });
    await expect(failing).rejects.toMatchObject({ errorClass: 'terminal', status: 400 });
  });
});

describe('AC-6: verification reads the account back and compares against intent', () => {
  it('passes when the observed state matches the request', async () => {
    const result = await runPhase();
    expect(result).toMatchObject({ status: 'succeeded' });
  });

  it('fails when the account is missing a requested group', async () => {
    await runPhase();
    domain.memberships.get(PAYLOAD.groups[1])!.delete(PAYLOAD.primaryEmail);

    await expect(run('verify-account')).rejects.toThrow(`not a member of ${PAYLOAD.groups[1]}`);
  });

  it('fails when the org unit does not match what was asked for', async () => {
    await runPhase();
    domain.users.get(PAYLOAD.primaryEmail)!.orgUnitPath = '/Somewhere-Else';

    await expect(run('verify-account')).rejects.toThrow(/orgUnitPath is \/Somewhere-Else/);
  });

  it('fails when the forced password change was not set', async () => {
    await runPhase();
    domain.users.get(PAYLOAD.primaryEmail)!.changePasswordAtNextLogin = false;

    await expect(run('verify-account')).rejects.toThrow('changePasswordAtNextLogin is not set');
  });

  it('fails when the account disappeared entirely', async () => {
    await runPhase();
    domain.users.delete(PAYLOAD.primaryEmail);

    await expect(run('verify-account')).rejects.toMatchObject({ status: 404 });
  });

  it('reports every problem it found, not just the first', async () => {
    await runPhase();
    const user = domain.users.get(PAYLOAD.primaryEmail)!;
    user.orgUnitPath = '/Wrong';
    user.changePasswordAtNextLogin = false;

    const err = await run('verify-account').catch((e: Error) => e);
    expect((err as Error).message).toContain('orgUnitPath');
    expect((err as Error).message).toContain('changePasswordAtNextLogin');
  });
});

describe('REQ-013 AC-1: replaying a step against a satisfied domain mutates nothing', () => {
  it('skips user creation when the account already exists', async () => {
    await run('create-user');
    const afterFirst = domain.countCalls('insertUser');

    const replay = await run('create-user');

    expect(replay).toMatchObject({ status: 'skipped' });
    expect(domain.countCalls('insertUser')).toBe(afterFirst);
    expect(credentials.stashed).toHaveLength(1);
  });

  it('skips attribute application when the attributes already match', async () => {
    await run('create-user');
    await run('apply-attributes');
    const afterFirst = domain.countCalls('updateUser');

    const replay = await run('apply-attributes');

    expect(replay).toMatchObject({ status: 'skipped' });
    expect(domain.countCalls('updateUser')).toBe(afterFirst);
  });

  it('skips group assignment when the user is already a member', async () => {
    const groupKey = PAYLOAD.groups[0];
    await run('create-user');
    await run('assign-group', { step: { input: { groupKey } } });
    const afterFirst = domain.countCalls(`addMember:${groupKey}`);

    const replay = await run('assign-group', { step: { input: { groupKey } } });

    expect(replay).toMatchObject({ status: 'skipped' });
    expect(domain.countCalls(`addMember:${groupKey}`)).toBe(afterFirst);
  });

  it('replays every mutating step of the phase with no duplicate mutation', async () => {
    await runPhase();
    const mutations =
      domain.countCalls('insertUser') + domain.countCalls('updateUser') + domain.countCalls('addMember');

    // Replay from create-user, not from validate-request. See the guard test
    // below for why validation is deliberately excluded.
    await run('create-user');
    await run('apply-attributes');
    for (const groupKey of PAYLOAD.groups) {
      await run('assign-group', { step: { input: { groupKey } } });
    }
    const second = await run('verify-account');

    expect(second).toMatchObject({ status: 'succeeded' });
    expect(
      domain.countCalls('insertUser') + domain.countCalls('updateUser') + domain.countCalls('addMember'),
    ).toBe(mutations);
  });

  /**
   * validate-request is a guard, not a mutation, and it is the one step that
   * deliberately does NOT resolve as satisfied on replay: REQ-003 AC-3 requires
   * a colliding primary email to fail. A guard that skipped when the account
   * already existed would make that criterion unmeetable. Replaying it after
   * its own phase has created the account is not a real delivery either, since
   * the executor's transactional claim (REQ-016 AC-2) means a second delivery
   * of a completed step never reaches the handler.
   *
   * This test pins that intent so the conflict is visible rather than being
   * rediscovered as a bug.
   */
  it('deliberately refuses to skip validation, which is a guard rather than a mutation', async () => {
    await run('create-user');

    await expect(run('validate-request')).rejects.toMatchObject({ errorClass: 'terminal', status: 409 });
    expect(domain.countCalls('insertUser')).toBe(1);
  });
});

describe('REQ-013 AC-5: a mutation that landed before a client timeout is not applied twice', () => {
  it('detects the server-side success on the next attempt through the pre-mutation read', async () => {
    // The account is created, then the response is lost: the handler never
    // returns, so the step is retried with the domain already changed.
    domain.failures.set(`insertUser:${PAYLOAD.primaryEmail}`, { code: 504, message: 'gateway timeout' });
    await run('create-user').catch(() => undefined);

    // Model the mutation having landed despite the lost response.
    await domain.insertUser({
      primaryEmail: PAYLOAD.primaryEmail,
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      password: 'irrelevant',
      changePasswordAtNextLogin: true,
      orgUnitPath: '/Engineering',
    });
    const landed = domain.countCalls('insertUser');

    const retry = await run('create-user');

    expect(retry).toMatchObject({ status: 'skipped' });
    expect(domain.countCalls('insertUser')).toBe(landed);
    expect(domain.users.size).toBe(1);
  });

  it('does not stash a second credential for an account it skipped', async () => {
    await run('create-user');
    await run('create-user');

    expect(credentials.stashed).toHaveLength(1);
  });
});
