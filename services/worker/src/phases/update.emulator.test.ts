import {
  CredentialStore,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type LifecycleStep,
} from '@lifecycle/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advance } from '../steps/advance.js';
import { executeStep } from '../steps/executor.js';
import './update.js';
import { emulatorDb, inMemoryKeys, silentDispatcher, wipeAll } from '@lifecycle/test-support';

/**
 * TC-REQ-005-1, -2, -7 and -8 at the level the criteria are actually written
 * at: the REQUEST, not the handler.
 *
 * The unit suite proves what each handler does to a domain. What it cannot show
 * is that the diff is persisted on the request before anything mutates, that it
 * is still there and complete when a step halts for an approver, that one
 * failing group leaves the rest standing while the request itself refuses to
 * report success, and that a missing account stops the whole thing at
 * validation. All four are properties of the request as it moves, so they run
 * through the real executor against the emulator.
 */

const db = emulatorDb();
const store = new LifecycleStore(db);

const credentials = new CredentialStore(db, inMemoryKeys());

const OPERATOR = 'operator@company.com';
const ACTOR: AuditActor = { kind: 'human', email: OPERATOR };
const TARGET = 'ada.lovelace@company.com';
const GROUP_A = 'platform@company.com';
const GROUP_B = 'research@company.com';

/** Halts the step that applies attributes, so an approver sees the diff. */
const HALT_APPLY: ApprovalPolicy = {
  ...DEFAULT_POLICY,
  update: { 'apply-update-attributes': { requiresApproval: true, approverRole: 'approver' } },
};

/** An in-memory domain with the surface phase 3 uses. */
class FakeDomain {
  user: Record<string, unknown> | null = null;
  memberships = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  failures = new Map<string, unknown>();

  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failures.has(op)) throw this.failures.get(op);
  }

  async getUser() {
    this.maybeFail('getUser');
    return this.user;
  }

  async patchUser(_primaryEmail: string, patch: Record<string, unknown>) {
    this.maybeFail('patchUser');
    Object.assign(this.user!, patch);
    return this.user;
  }

  async hasMember(groupKey: string) {
    this.maybeFail(`hasMember:${groupKey}`);
    return this.memberships.get(groupKey)?.has(TARGET) ?? false;
  }

  async addMember(groupKey: string) {
    this.maybeFail(`addMember:${groupKey}`);
    const set = this.memberships.get(groupKey) ?? new Set<string>();
    set.add(TARGET);
    this.memberships.set(groupKey, set);
  }

  async removeMember(groupKey: string) {
    this.maybeFail(`removeMember:${groupKey}`);
    this.memberships.get(groupKey)?.delete(TARGET);
    return { removed: true };
  }

  countCalls(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }

  reset() {
    this.user = {
      id: 'id-1',
      primaryEmail: TARGET,
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      orgUnitPath: '/Engineering',
      organizations: [{ title: 'Staff Engineer', department: 'Platform', primary: true }],
      relations: [{ value: 'grace.hopper@company.com', type: 'manager' }],
    };
    this.memberships = new Map();
    this.calls.length = 0;
    this.failures = new Map();
  }
}

const directory = new FakeDomain();


function deps() {
  return {
    store,
    directory: directory as never,
    credentials,
    advance: (requestId: string, completedStepId: string) =>
      advance({ store, dispatcher: silentDispatcher }, requestId, completedStepId),
  };
}

const wipe = () => wipeAll(db);

beforeAll(wipe);
// Seeded before EVERY test rather than only after each one. Resetting on the
// way out leaves the first test in the file running against an empty domain,
// which is a different test from the one it says it is.
beforeEach(() => directory.reset());
afterEach(wipe);

/** Submits an update request and returns its id and planned steps. */
async function submit(payload: Record<string, unknown>, policy: ApprovalPolicy = DEFAULT_POLICY) {
  const full = { primaryEmail: TARGET, ...payload };
  const documents = buildNewRequest({
    phase: 'update',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload: full,
    plan: stepPlanFor('update', full),
    policy,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);
  return { requestId: documents.request.requestId, steps: documents.steps };
}

/**
 * Drives steps in plan order until one does not settle as succeeded or skipped.
 * Returns the step that stopped the run, if any.
 */
async function drive(
  requestId: string,
  steps: LifecycleStep[],
): Promise<{ stoppedAt: LifecycleStep | null }> {
  for (const step of steps) {
    const live = (await store.listSteps(requestId)).find((s) => s.stepId === step.stepId)!;
    // advance() releases each step as its predecessor settles; anything not
    // ready is a halt or a stop, and driving past it would be fiction.
    if (live.status !== 'ready') return { stoppedAt: live };

    const outcome = await executeStep(deps(), {
      requestId,
      stepId: step.stepId,
      attempt: 1,
    });
    if (outcome.kind === 'settled' && outcome.status === 'failed') {
      return { stoppedAt: live };
    }
  }
  return { stoppedAt: null };
}

// ------------------------------------------------------------------- AC-1

describe('AC-1: the diff is persisted on the request before execution', () => {
  it('writes the change set onto the request', async () => {
    const { requestId, steps } = await submit({ title: 'Principal Engineer' });

    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
    await executeStep(deps(), { requestId, stepId: steps[1]!.stepId, attempt: 1 });

    const diff = (await store.getRequest(requestId))!.computedDiff!;
    expect(diff.targetUser).toBe(TARGET);
    expect(diff.attributes).toEqual([
      { field: 'title', before: 'Staff Engineer', after: 'Principal Engineer', changed: true },
    ]);
  });

  it('is null until the diff step runs', async () => {
    const { requestId, steps } = await submit({ title: 'Principal Engineer' });

    expect((await store.getRequest(requestId))!.computedDiff).toBeNull();

    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
    expect((await store.getRequest(requestId))!.computedDiff).toBeNull();
  });

  it('is written before anything has mutated', async () => {
    // The ordering claim, observed rather than inferred from the plan: at the
    // moment the diff exists, no write has reached the domain.
    const { requestId, steps } = await submit({
      title: 'Principal Engineer',
      addGroups: [GROUP_A],
    });

    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
    await executeStep(deps(), { requestId, stepId: steps[1]!.stepId, attempt: 1 });

    expect((await store.getRequest(requestId))!.computedDiff).not.toBeNull();
    expect(directory.countCalls('patchUser')).toBe(0);
    expect(directory.countCalls('addMember')).toBe(0);
  });

  it('audits the computation in the same transaction that persists it', async () => {
    const { requestId, steps } = await submit({ title: 'Principal Engineer' });

    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
    await executeStep(deps(), { requestId, stepId: steps[1]!.stepId, attempt: 1 });

    const event = (await store.listAudit(requestId)).find(
      (e) => e.action === 'request.diff_computed',
    )!;
    expect(event).toBeDefined();
    expect(event.targetUser).toBe(TARGET);
    expect(event.actor).toMatchObject({ kind: 'system', onBehalfOf: OPERATOR });
  });
});

// ------------------------------------------------------------------- AC-2

describe('AC-2: an approver sees the resolved change set, not the raw payload', () => {
  it('carries a complete diff on the request when the step halts for approval', async () => {
    directory.memberships.set(GROUP_B, new Set([TARGET]));
    const { requestId, steps } = await submit(
      {
        title: 'Principal Engineer',
        managerEmail: null,
        addGroups: [GROUP_A],
        removeGroups: [GROUP_B],
      },
      HALT_APPLY,
    );

    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
    await executeStep(deps(), { requestId, stepId: steps[1]!.stepId, attempt: 1 });

    const request = (await store.getRequest(requestId))!;
    expect(request.status).toBe('awaiting_approval');

    const diff = request.computedDiff!;
    // Every change carries where it is coming FROM as well as going to, which
    // is the difference between an approval screen and a payload dump.
    expect(diff.attributes).toEqual([
      { field: 'title', before: 'Staff Engineer', after: 'Principal Engineer', changed: true },
      {
        field: 'managerEmail',
        before: 'grace.hopper@company.com',
        after: null,
        changed: true,
      },
    ]);
    expect(diff.groups).toEqual([
      { groupKey: GROUP_A, operation: 'add', before: false, after: true, changed: true },
      { groupKey: GROUP_B, operation: 'remove', before: true, after: false, changed: true },
    ]);
  });

  it('halts with nothing mutated, so the approver decides before any change', async () => {
    const { requestId, steps } = await submit({ title: 'Principal Engineer' }, HALT_APPLY);

    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
    await executeStep(deps(), { requestId, stepId: steps[1]!.stepId, attempt: 1 });

    expect(directory.countCalls('patchUser')).toBe(0);
    const apply = (await store.listSteps(requestId)).find(
      (s) => s.name === 'apply-update-attributes',
    )!;
    expect(apply.status).toBe('awaiting_approval');
  });

  it('applies exactly what was approved once the approver releases it', async () => {
    const { requestId, steps } = await submit({ title: 'Principal Engineer' }, HALT_APPLY);
    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
    await executeStep(deps(), { requestId, stepId: steps[1]!.stepId, attempt: 1 });

    const apply = (await store.listSteps(requestId)).find(
      (s) => s.name === 'apply-update-attributes',
    )!;
    await store.decideStep({
      requestId,
      stepId: apply.stepId,
      decision: 'approved',
      approver: { kind: 'human', email: 'approver@company.com' },
      justification: 'agreed with the promotion',
    });
    await executeStep(deps(), { requestId, stepId: apply.stepId, attempt: 1 });

    expect((directory.user!.organizations as { title: string }[])[0]!.title).toBe(
      'Principal Engineer',
    );
  });
});

// ------------------------------------------------------------------- AC-7

describe('AC-7: one failing group change keeps the others and fails the request', () => {
  it('retains the membership that succeeded', async () => {
    const { requestId, steps } = await submit({ addGroups: [GROUP_A, 'oncall@company.com'] });
    directory.failures.set('addMember:oncall@company.com', {
      code: 400,
      message: 'no such group',
    });

    await drive(requestId, steps);

    // The first group stands. Nothing rolls back: a partial result an operator
    // can see and finish is better than an undone one they cannot.
    expect(directory.memberships.get(GROUP_A)!.has(TARGET)).toBe(true);
    expect(directory.memberships.get('oncall@company.com')).toBeUndefined();
  });

  it('reports the failure on its own step, naming the group', async () => {
    const { requestId, steps } = await submit({ addGroups: [GROUP_A, 'oncall@company.com'] });
    directory.failures.set('addMember:oncall@company.com', {
      code: 400,
      message: 'no such group',
    });

    await drive(requestId, steps);

    const live = await store.listSteps(requestId);
    const succeeded = live.find((s) => s.input.groupKey === GROUP_A)!;
    const failed = live.find((s) => s.input.groupKey === 'oncall@company.com')!;

    expect(succeeded.status).toBe('succeeded');
    expect(failed.status).toBe('failed');
    expect(failed.error).not.toBeNull();
  });

  it('does not report the request as successful', async () => {
    const { requestId, steps } = await submit({ addGroups: [GROUP_A, 'oncall@company.com'] });
    directory.failures.set('addMember:oncall@company.com', {
      code: 400,
      message: 'no such group',
    });

    await drive(requestId, steps);

    expect((await store.getRequest(requestId))!.status).toBe('failed');
  });

  it('dispatches no later step after the failure', async () => {
    const { requestId, steps } = await submit({
      addGroups: ['oncall@company.com', GROUP_A],
    });
    directory.failures.set('addMember:oncall@company.com', {
      code: 400,
      message: 'no such group',
    });

    await drive(requestId, steps);

    const live = await store.listSteps(requestId);
    const later = live.find((s) => s.input.groupKey === GROUP_A)!;
    expect(later.status).toBe('pending');
    expect(live.find((s) => s.name === 'verify-update')!.status).toBe('pending');
  });
});

// ------------------------------------------------------------------- AC-8

describe('AC-8: a request for an account that is not there fails validation', () => {
  it('fails the step with a typed validation error', async () => {
    directory.user = null;
    const { requestId, steps } = await submit({ title: 'Principal Engineer' });

    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });

    const step = (await store.listSteps(requestId))[0]!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatchObject({ class: 'validation', code: 'user_not_found' });
    expect(step.error!.message).toContain(TARGET);
  });

  it('terminates the request and attempts no mutation', async () => {
    directory.user = null;
    const { requestId, steps } = await submit({
      title: 'Principal Engineer',
      addGroups: [GROUP_A],
    });

    await drive(requestId, steps);

    expect((await store.getRequest(requestId))!.status).toBe('failed');
    expect(directory.countCalls('patchUser')).toBe(0);
    expect(directory.countCalls('addMember')).toBe(0);
    expect(directory.countCalls('removeMember')).toBe(0);
  });

  it('computes no diff for an account that is not there', async () => {
    directory.user = null;
    const { requestId, steps } = await submit({ title: 'Principal Engineer' });

    await drive(requestId, steps);

    expect((await store.getRequest(requestId))!.computedDiff).toBeNull();
  });

  it('settles rather than asking Cloud Tasks to redeliver', async () => {
    // A missing account does not heal on retry.
    directory.user = null;
    const { requestId, steps } = await submit({ title: 'Principal Engineer' });

    const outcome = await executeStep(deps(), {
      requestId,
      stepId: steps[0]!.stepId,
      attempt: 1,
    });

    expect(outcome).toEqual({ kind: 'settled', status: 'failed' });
  });
});

// ------------------------------------------------------- the whole phase

describe('a full update runs end to end', () => {
  it('changes attributes and both directions of membership, then verifies', async () => {
    directory.memberships.set(GROUP_B, new Set([TARGET]));
    const { requestId, steps } = await submit({
      title: 'Principal Engineer',
      department: 'Research',
      orgUnitPath: '/Research',
      addGroups: [GROUP_A],
      removeGroups: [GROUP_B],
    });

    const { stoppedAt } = await drive(requestId, steps);

    expect(stoppedAt).toBeNull();
    expect((await store.getRequest(requestId))!.status).toBe('succeeded');
    expect(directory.user!.orgUnitPath).toBe('/Research');
    expect(directory.memberships.get(GROUP_A)!.has(TARGET)).toBe(true);
    expect(directory.memberships.get(GROUP_B)!.has(TARGET)).toBe(false);
  });

  it('reports every no-op step as skipped rather than succeeded (AC-5)', async () => {
    // Nothing in this request differs from live state, so every step that
    // could act reports that it did not.
    directory.memberships.set(GROUP_A, new Set([TARGET]));
    const { requestId, steps } = await submit({
      title: 'Staff Engineer',
      addGroups: [GROUP_A],
      removeGroups: [GROUP_B],
    });

    await drive(requestId, steps);

    const live = await store.listSteps(requestId);
    expect(live.find((s) => s.name === 'apply-update-attributes')!.status).toBe('skipped');
    expect(live.find((s) => s.input.groupKey === GROUP_A)!.status).toBe('skipped');
    expect(live.find((s) => s.input.groupKey === GROUP_B)!.status).toBe('skipped');
    expect((await store.getRequest(requestId))!.status).toBe('succeeded');
    expect(directory.countCalls('patchUser')).toBe(0);
    expect(directory.countCalls('addMember')).toBe(0);
    expect(directory.countCalls('removeMember')).toBe(0);
  });
});
