import { Timestamp } from '@google-cloud/firestore';
import type { LifecycleRequest, LifecycleStep, UpdateDiff } from '@lifecycle/shared';
import type { admin_directory_v1 } from 'googleapis';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * TC-REQ-005-1 through TC-REQ-005-7: phase 3 against a fake Workspace domain.
 *
 * The fake holds users, organizations, relations and memberships in memory and
 * answers what the Directory API answers, so a no-op really is a no-op: a
 * handler that patches redundantly and a handler that correctly skips both look
 * identical to a mock, and the difference is most of this requirement.
 *
 * The patch bodies are captured verbatim rather than only their effect,
 * because AC-3 is a claim about what is SENT. An update that overwrote a
 * neighbouring field with its own current value would leave the domain looking
 * correct while doing something this phase promises not to do.
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
await import('./update.js');

type User = admin_directory_v1.Schema$User;

const TARGET = 'ada.lovelace@company.com';
const GROUP_A = 'platform@company.com';
const GROUP_B = 'research@company.com';

/** An in-memory Workspace domain with the surface phase 3 uses. */
class FakeDomain {
  users = new Map<string, User>();
  memberships = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  /** Every patch body sent, in order, so AC-3 can assert on what was sent. */
  readonly patches: Record<string, unknown>[] = [];
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

  async patchUser(primaryEmail: string, patch: Record<string, unknown>): Promise<User> {
    this.maybeFail(`patchUser:${primaryEmail}`);
    const user = this.users.get(primaryEmail.toLowerCase());
    if (!user) throw { code: 404, message: 'Not found' };
    this.patches.push(patch);
    // Merge semantics: only the named keys move, which is what users.patch does.
    Object.assign(user, patch);
    return user;
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

  async removeMember(groupKey: string, memberEmail: string): Promise<{ removed: boolean }> {
    this.maybeFail(`removeMember:${groupKey}`);
    const removed = this.memberships.get(groupKey)?.delete(memberEmail.toLowerCase()) ?? false;
    return { removed };
  }

  countCalls(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

/** Records the frozen diff instead of writing it, and hands it back on read. */
class FakeStore {
  readonly recorded: { requestId: string; stepId: string; diff: UpdateDiff }[] = [];

  async recordComputedDiff(params: { requestId: string; stepId: string; diff: UpdateDiff }) {
    this.recorded.push({ requestId: params.requestId, stepId: params.stepId, diff: params.diff });
  }

  get lastDiff(): UpdateDiff {
    return this.recorded[this.recorded.length - 1]!.diff;
  }
}

let domain: FakeDomain;
let store: FakeStore;

/** The account every test starts from, unless it changes it. */
function seedUser(overrides: Partial<User> = {}) {
  domain.users.set(TARGET, {
    id: 'id-1',
    primaryEmail: TARGET,
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    orgUnitPath: '/Engineering',
    organizations: [{ title: 'Staff Engineer', department: 'Platform', primary: true }],
    relations: [{ value: 'grace.hopper@company.com', type: 'manager' }],
    ...overrides,
  });
}

beforeEach(() => {
  domain = new FakeDomain();
  store = new FakeStore();
  seedUser();
});

function context(options: {
  step?: Partial<LifecycleStep>;
  payload?: Record<string, unknown>;
  computedDiff?: UpdateDiff | null;
}) {
  const request = {
    requestId: 'req-005',
    phase: 'update',
    status: 'running',
    targetUser: TARGET,
    requestedBy: 'operator@company.com',
    payload: options.payload ?? { primaryEmail: TARGET },
    policySnapshot: {},
    computedDiff: options.computedDiff ?? null,
    holdUntil: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  } as unknown as LifecycleRequest;

  const step = {
    stepId: 'step-1',
    name: 'compute-update-diff',
    ordinal: 0,
    status: 'running',
    attempts: 1,
    requiresApproval: false,
    idempotencyKey: 'req-005:step-1:hash',
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
    store: store as never,
    directory: domain as never,
    credentials: {} as never,
  };
}

const run = (
  name: string,
  options: Parameters<typeof context>[0] = {},
) => resolveHandler(name).execute(context({ ...options, step: { name, ...options.step } }));

/** Runs the diff step, then hands its result to a later step as frozen state. */
async function withDiff(payload: Record<string, unknown>) {
  await run('compute-update-diff', { payload });
  return { payload, computedDiff: store.lastDiff };
}

// ------------------------------------------------------------------- AC-1

describe('AC-1: the diff is computed against live state and frozen', () => {
  it('records the live value of every requested attribute', async () => {
    await run('compute-update-diff', {
      payload: { primaryEmail: TARGET, title: 'Principal Engineer', department: 'Platform' },
    });

    expect(store.lastDiff.attributes).toEqual([
      { field: 'title', before: 'Staff Engineer', after: 'Principal Engineer', changed: true },
      // Requested and already true. Present, so an approver sees what was asked.
      { field: 'department', before: 'Platform', after: 'Platform', changed: false },
    ]);
  });

  it('records live membership for every requested group', async () => {
    domain.memberships.set(GROUP_B, new Set([TARGET]));

    await run('compute-update-diff', {
      payload: { primaryEmail: TARGET, addGroups: [GROUP_A], removeGroups: [GROUP_B] },
    });

    expect(store.lastDiff.groups).toEqual([
      { groupKey: GROUP_A, operation: 'add', before: false, after: true, changed: true },
      { groupKey: GROUP_B, operation: 'remove', before: true, after: false, changed: true },
    ]);
  });

  it('normalises absent, null and empty-string to one representation', async () => {
    // Workspace can express "no title" three ways depending on how the account
    // was last written. A diff that treated them as different values would
    // report a change nobody asked for.
    seedUser({ organizations: [{ title: '', department: null, primary: true }], relations: [] });

    await run('compute-update-diff', {
      payload: { primaryEmail: TARGET, title: null, department: null, managerEmail: null },
    });

    expect(store.lastDiff.attributes.every((a) => a.before === null && a.changed === false)).toBe(true);
  });

  it('reads the diff against the account, not the payload', async () => {
    const before = domain.countCalls('getUser');

    await run('compute-update-diff', { payload: { primaryEmail: TARGET, title: 'Lead' } });

    expect(domain.countCalls('getUser')).toBe(before + 1);
  });

  it('refuses to compute a diff for an account that is gone', async () => {
    domain.users.clear();

    await expect(run('compute-update-diff', { payload: { primaryEmail: TARGET, title: 'Lead' } }))
      .rejects.toBeInstanceOf(UserNotFoundError);
  });
});

// ------------------------------------------------------------------- AC-2

describe('AC-2: the frozen diff carries before and after for everything requested', () => {
  it('gives every entry a before, an after and a changed flag', async () => {
    domain.memberships.set(GROUP_B, new Set([TARGET]));

    await run('compute-update-diff', {
      payload: {
        primaryEmail: TARGET,
        title: 'Principal Engineer',
        managerEmail: null,
        addGroups: [GROUP_A],
        removeGroups: [GROUP_B],
      },
    });
    const diff = store.lastDiff;

    for (const entry of [...diff.attributes, ...diff.groups]) {
      expect(entry).toHaveProperty('before');
      expect(entry).toHaveProperty('after');
      expect(entry).toHaveProperty('changed');
    }
    // Clearing shows as a real transition, not as an absence.
    expect(diff.attributes.find((a) => a.field === 'managerEmail')).toEqual({
      field: 'managerEmail',
      before: 'grace.hopper@company.com',
      after: null,
      changed: true,
    });
  });

  it('names the target and stamps when it was computed', async () => {
    await run('compute-update-diff', { payload: { primaryEmail: TARGET, title: 'Lead' } });

    expect(store.lastDiff.targetUser).toBe(TARGET);
    expect(store.lastDiff.computedAt).toBeInstanceOf(Timestamp);
  });
});

// ------------------------------------------------------------------- AC-3

describe('AC-3: applying changes exactly what is in the diff', () => {
  it('sends only the fields being changed', async () => {
    const frozen = await withDiff({ primaryEmail: TARGET, title: 'Principal Engineer' });

    await run('apply-update-attributes', frozen);

    expect(domain.patches).toHaveLength(1);
    // name, orgUnitPath and relations are absent: untouched fields are not
    // sent at all, so nothing can overwrite them.
    expect(Object.keys(domain.patches[0]!)).toEqual(['organizations']);
  });

  it('preserves the neighbouring field inside a whole-array resource', async () => {
    // organizations is replaced wholesale even under patch semantics, so
    // changing the title without merging would silently drop the department.
    const frozen = await withDiff({ primaryEmail: TARGET, title: 'Principal Engineer' });

    await run('apply-update-attributes', frozen);

    expect(domain.users.get(TARGET)!.organizations).toEqual([
      { title: 'Principal Engineer', department: 'Platform', primary: true },
    ]);
  });

  it('preserves non-manager relations when the manager changes', async () => {
    seedUser({
      relations: [
        { value: 'grace.hopper@company.com', type: 'manager' },
        { value: 'alan.turing@company.com', type: 'mentor' },
      ],
    });
    const frozen = await withDiff({ primaryEmail: TARGET, managerEmail: 'katherine@company.com' });

    await run('apply-update-attributes', frozen);

    expect(domain.users.get(TARGET)!.relations).toEqual([
      { value: 'alan.turing@company.com', type: 'mentor' },
      { value: 'katherine@company.com', type: 'manager' },
    ]);
  });

  it('drops only the manager entry when the manager is cleared', async () => {
    seedUser({
      relations: [
        { value: 'grace.hopper@company.com', type: 'manager' },
        { value: 'alan.turing@company.com', type: 'mentor' },
      ],
    });
    const frozen = await withDiff({ primaryEmail: TARGET, managerEmail: null });

    await run('apply-update-attributes', frozen);

    expect(domain.users.get(TARGET)!.relations).toEqual([
      { value: 'alan.turing@company.com', type: 'mentor' },
    ]);
  });

  it('sends both halves of a name when only one is changing', async () => {
    // name is a whole-object field: patching the given name alone would clear
    // the family name.
    const frozen = await withDiff({ primaryEmail: TARGET, givenName: 'Augusta' });

    await run('apply-update-attributes', frozen);

    expect(domain.patches[0]!.name).toEqual({ givenName: 'Augusta', familyName: 'Lovelace' });
  });

  it('leaves every other user field untouched', async () => {
    const beforeUser = { ...domain.users.get(TARGET)! };
    const frozen = await withDiff({ primaryEmail: TARGET, title: 'Principal Engineer' });

    await run('apply-update-attributes', frozen);

    const after = domain.users.get(TARGET)!;
    expect(after.id).toBe(beforeUser.id);
    expect(after.primaryEmail).toBe(beforeUser.primaryEmail);
    expect(after.name).toEqual(beforeUser.name);
    expect(after.orgUnitPath).toBe(beforeUser.orgUnitPath);
    expect(after.relations).toEqual(beforeUser.relations);
  });

  it('applies what was approved, not what the payload said', async () => {
    // The point of freezing. The account moves after the diff is computed; the
    // apply step must not silently widen the change an approver signed off.
    const frozen = await withDiff({ primaryEmail: TARGET, title: 'Principal Engineer' });
    seedUser({ organizations: [{ title: 'Staff Engineer', department: 'Research', primary: true }] });

    await run('apply-update-attributes', frozen);

    // Department was never in the diff, so it keeps whatever it drifted to.
    expect(domain.users.get(TARGET)!.organizations).toEqual([
      { title: 'Principal Engineer', department: 'Research', primary: true },
    ]);
  });

  it('fails terminally when it is reached with no diff frozen', async () => {
    await expect(
      run('apply-update-attributes', {
        payload: { primaryEmail: TARGET, title: 'Lead' },
        computedDiff: null,
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });
});

// ------------------------------------------------------------------- AC-4

describe('AC-4: every role-describing attribute is updatable', () => {
  it.each([
    ['givenName', 'Augusta', (u: User) => u.name?.givenName],
    ['familyName', 'King', (u: User) => u.name?.familyName],
    ['title', 'Principal Engineer', (u: User) => u.organizations?.[0]?.title],
    ['department', 'Research', (u: User) => u.organizations?.[0]?.department],
    ['orgUnitPath', '/Research', (u: User) => u.orgUnitPath],
    [
      'managerEmail',
      'katherine@company.com',
      (u: User) => u.relations?.find((r: { type?: string | null }) => r.type === 'manager')?.value,
    ],
  ])('changes %s', async (field, value, read) => {
    const frozen = await withDiff({ primaryEmail: TARGET, [field]: value });

    await run('apply-update-attributes', frozen);

    expect(read(domain.users.get(TARGET)!)).toBe(value);
  });

  it('changes group membership in both directions', async () => {
    domain.memberships.set(GROUP_B, new Set([TARGET]));
    const payload = { primaryEmail: TARGET, addGroups: [GROUP_A], removeGroups: [GROUP_B] };

    await run('add-group', { payload, step: { input: { groupKey: GROUP_A } } });
    await run('remove-group', { payload, step: { input: { groupKey: GROUP_B } } });

    expect(domain.memberships.get(GROUP_A)!.has(TARGET)).toBe(true);
    expect(domain.memberships.get(GROUP_B)!.has(TARGET)).toBe(false);
  });

  it('changes several attributes in one call', async () => {
    const frozen = await withDiff({
      primaryEmail: TARGET,
      title: 'Principal Engineer',
      department: 'Research',
      orgUnitPath: '/Research',
    });

    await run('apply-update-attributes', frozen);

    // One patch, not three. Workspace applies a patch atomically; three calls
    // would leave the account half-updated if the second failed.
    expect(domain.countCalls('patchUser')).toBe(1);
    const user = domain.users.get(TARGET)!;
    expect(user.orgUnitPath).toBe('/Research');
    expect(user.organizations).toEqual([
      { title: 'Principal Engineer', department: 'Research', primary: true },
    ]);
  });
});

// ------------------------------------------------------------------- AC-5

describe('AC-5: a change that already matches live state is skipped', () => {
  it('skips the attribute step and issues no Workspace write', async () => {
    const frozen = await withDiff({ primaryEmail: TARGET, title: 'Staff Engineer' });

    const result = await run('apply-update-attributes', frozen);

    expect(result.status).toBe('skipped');
    expect(domain.countCalls('patchUser')).toBe(0);
  });

  it('skips adding a group the user is already in', async () => {
    domain.memberships.set(GROUP_A, new Set([TARGET]));

    const result = await run('add-group', {
      payload: { primaryEmail: TARGET, addGroups: [GROUP_A] },
      step: { input: { groupKey: GROUP_A } },
    });

    expect(result.status).toBe('skipped');
    expect(domain.countCalls('addMember')).toBe(0);
  });

  it('applies the outstanding fields and ignores the settled ones', async () => {
    const frozen = await withDiff({
      primaryEmail: TARGET,
      title: 'Principal Engineer',
      department: 'Platform',
    });

    const result = await run('apply-update-attributes', frozen);

    expect(result.status).toBe('succeeded');
    expect(result.output!.applied).toEqual(['title']);
  });

  it('skips on a replay, after the change has already landed', async () => {
    // The redelivery case. The first run applies; the second finds live state
    // already correct and does nothing, which is what makes at-least-once
    // delivery safe (REQ-013).
    const frozen = await withDiff({ primaryEmail: TARGET, title: 'Principal Engineer' });

    const first = await run('apply-update-attributes', frozen);
    const second = await run('apply-update-attributes', frozen);

    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('skipped');
    expect(domain.countCalls('patchUser')).toBe(1);
  });
});

// ------------------------------------------------------------------- AC-6

describe('AC-6: removing a membership the user does not have is already satisfied', () => {
  it('skips rather than failing', async () => {
    const result = await run('remove-group', {
      payload: { primaryEmail: TARGET, removeGroups: [GROUP_B] },
      step: { input: { groupKey: GROUP_B } },
    });

    expect(result.status).toBe('skipped');
    expect(result.output).toMatchObject({ group: GROUP_B, reason: 'not a member' });
  });

  it('issues no removal call at all', async () => {
    await run('remove-group', {
      payload: { primaryEmail: TARGET, removeGroups: [GROUP_B] },
      step: { input: { groupKey: GROUP_B } },
    });

    expect(domain.countCalls('removeMember')).toBe(0);
  });

  it('is idempotent: a replay after a real removal also skips', async () => {
    domain.memberships.set(GROUP_B, new Set([TARGET]));
    const options = {
      payload: { primaryEmail: TARGET, removeGroups: [GROUP_B] },
      step: { input: { groupKey: GROUP_B } },
    };

    expect((await run('remove-group', options)).status).toBe('succeeded');
    expect((await run('remove-group', options)).status).toBe('skipped');
    expect(domain.countCalls('removeMember')).toBe(1);
  });
});

// ------------------------------------------------------------------- AC-7

describe('AC-7: one failing group change does not discard the others', () => {
  it('keeps the memberships that succeeded and fails only its own step', async () => {
    const payload = {
      primaryEmail: TARGET,
      addGroups: [GROUP_A, 'oncall@company.com'],
    };
    domain.failures.set('addMember:oncall@company.com', { code: 500, message: 'backend error' });

    await run('add-group', { payload, step: { input: { groupKey: GROUP_A } } });
    await expect(
      run('add-group', { payload, step: { input: { groupKey: 'oncall@company.com' } } }),
    ).rejects.toBeTruthy();

    // The first membership stands. Nothing rolls back, because the steps are
    // independent and a partial result is better than an undone one.
    expect(domain.memberships.get(GROUP_A)!.has(TARGET)).toBe(true);
    expect(domain.memberships.get('oncall@company.com')).toBeUndefined();
  });

  it('names the group on the step that failed', async () => {
    // The step carries the group on its input, so the failure identifies which
    // one without the operator having to reconstruct it from ordering.
    const payload = { primaryEmail: TARGET, addGroups: ['oncall@company.com'] };
    domain.failures.set('addMember:oncall@company.com', { code: 500, message: 'backend error' });

    await expect(
      run('add-group', { payload, step: { input: { groupKey: 'oncall@company.com' } } }),
    ).rejects.toBeTruthy();
    expect(domain.calls).toContain('addMember:oncall@company.com');
  });

  it('refuses a group step that carries no group key', async () => {
    await expect(
      run('add-group', { payload: { primaryEmail: TARGET }, step: { input: {} } }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });
});

// ------------------------------------------------------------------- AC-8

describe('AC-8: a request for an account that is not there fails validation', () => {
  it('throws UserNotFoundError naming the address', async () => {
    domain.users.clear();

    const failing = run('validate-update-request', {
      payload: { primaryEmail: TARGET, title: 'Lead' },
    });

    await expect(failing).rejects.toBeInstanceOf(UserNotFoundError);
    await expect(failing).rejects.toThrow(TARGET);
  });

  it('attempts no mutation', async () => {
    domain.users.clear();

    await run('validate-update-request', { payload: { primaryEmail: TARGET, title: 'Lead' } }).catch(
      () => undefined,
    );

    expect(domain.countCalls('patchUser')).toBe(0);
    expect(domain.countCalls('addMember')).toBe(0);
    expect(domain.countCalls('removeMember')).toBe(0);
  });

  it('admits a suspended account, which is still a user', async () => {
    // Deliberate. Moving a suspended account between org units or groups is a
    // normal part of a leaver-then-returner flow; refusing it would make the
    // tool unusable for exactly the case phase 3 exists for.
    seedUser({ suspended: true });

    const result = await run('validate-update-request', {
      payload: { primaryEmail: TARGET, title: 'Lead' },
    });

    expect(result.status).toBe('succeeded');
    expect(result.output).toMatchObject({ suspended: true });
  });
});

// ------------------------------------------------------- verification step

describe('verify-update reads the result back', () => {
  it('succeeds when the account reached the approved state', async () => {
    domain.memberships.set(GROUP_B, new Set([TARGET]));
    const frozen = await withDiff({
      primaryEmail: TARGET,
      title: 'Principal Engineer',
      addGroups: [GROUP_A],
      removeGroups: [GROUP_B],
    });

    await run('apply-update-attributes', frozen);
    await run('add-group', { ...frozen, step: { input: { groupKey: GROUP_A } } });
    await run('remove-group', { ...frozen, step: { input: { groupKey: GROUP_B } } });

    expect((await run('verify-update', frozen)).status).toBe('succeeded');
  });

  it('fails when an attribute did not land', async () => {
    // The case a plan made entirely of skips would otherwise report as a
    // successful update.
    const frozen = await withDiff({ primaryEmail: TARGET, title: 'Principal Engineer' });

    await expect(run('verify-update', frozen)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('fails when a membership did not land, naming the group', async () => {
    const frozen = await withDiff({ primaryEmail: TARGET, addGroups: [GROUP_A] });

    await expect(run('verify-update', frozen)).rejects.toThrow(GROUP_A);
  });
});
