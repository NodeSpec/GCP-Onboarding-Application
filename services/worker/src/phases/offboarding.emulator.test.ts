import { Firestore } from '@google-cloud/firestore';
import { randomBytes } from 'node:crypto';
import {
  COLLECTIONS,
  COMPENSATING_STEP,
  CredentialStore,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  resolveStepPolicy,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type KeyProvider,
  type LifecycleStep,
} from '@lifecycle/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advance } from '../steps/advance.js';
import { WorkspaceError } from '../workspace/directoryClient.js';
import { executeStep } from '../steps/executor.js';
import './delete.js';

/**
 * TC-REQ-006-2 through -6 and -9: offboarding as a REQUEST, not as handlers.
 *
 * Compensating cancellation is the part that cannot be tested any other way.
 * The claim is not "cancel sets a status" but "cancel does work, and the
 * request only reports itself cancelled once that work succeeded" — which is a
 * property of a request moving through the executor, and whose failure mode is
 * the one that matters most: a request reading 'cancelled' while a real person
 * is still locked out of a real account.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const KEY = randomBytes(32);
const keys: KeyProvider = {
  resolve: async () => ({ key: KEY, version: 'versions/1' }),
  resolveVersion: async () => ({ key: KEY, version: 'versions/1' }),
};
const credentials = new CredentialStore(db, keys);

const OPERATOR = 'operator@company.com';
const ACTOR: AuditActor = { kind: 'human', email: OPERATOR };
const TARGET = 'ada.lovelace@company.com';

/** An in-memory domain with the surface phase 4 uses. */
class FakeDomain {
  suspended = false;
  present = true;
  memberships = new Set<string>();
  readonly calls: string[] = [];
  failures = new Map<string, unknown>();

  private maybeFail(op: string) {
    this.calls.push(op);
    if (this.failures.has(op)) throw this.failures.get(op);
  }

  async getUser() {
    this.maybeFail('getUser');
    return this.present ? { id: 'id-leaver', primaryEmail: TARGET, suspended: this.suspended } : null;
  }

  async setSuspended(_primaryEmail: string, suspended: boolean) {
    this.maybeFail(`setSuspended:${suspended}`);
    this.suspended = suspended;
  }

  async revokeTokens() {
    this.maybeFail('revokeTokens');
  }

  async listMemberships() {
    this.maybeFail('listMemberships');
    return [...this.memberships];
  }

  async removeMember(groupKey: string) {
    this.maybeFail('removeMember');
    return { removed: this.memberships.delete(groupKey) };
  }

  async deleteUser() {
    this.maybeFail('deleteUser');
    const existed = this.present;
    this.present = false;
    return { deleted: existed };
  }

  countCalls(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }

  reset() {
    this.suspended = false;
    this.present = true;
    this.memberships = new Set(['platform@company.com']);
    this.calls.length = 0;
    this.failures = new Map();
  }
}

const directory = new FakeDomain();

const silentDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

function deps() {
  return {
    store,
    directory: directory as never,
    credentials,
    advance: (requestId: string, completedStepId: string) =>
      advance({ store, dispatcher: silentDispatcher }, requestId, completedStepId),
  };
}

async function wipe() {
  for (const collection of [COLLECTIONS.requests, COLLECTIONS.audit, COLLECTIONS.credentialHandoffs]) {
    const snap = await db.collection(collection).get();
    await Promise.all(
      snap.docs.map(async (doc) => {
        const steps = await doc.ref.collection(COLLECTIONS.steps).get();
        await Promise.all(steps.docs.map((s) => s.ref.delete()));
        await doc.ref.delete();
      }),
    );
  }
}

beforeAll(wipe);
beforeEach(() => directory.reset());
afterEach(wipe);

/** Submits an offboarding request and releases its first step. */
async function submit(policy: ApprovalPolicy = DEFAULT_POLICY) {
  const payload = { primaryEmail: TARGET };
  const documents = buildNewRequest({
    phase: 'delete',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload,
    plan: stepPlanFor('delete', payload),
    policy,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);
  return { requestId: documents.request.requestId, steps: documents.steps };
}

/** Drives steps in plan order until one is not ready or does not settle. */
async function drive(requestId: string, steps: LifecycleStep[]) {
  for (const step of steps) {
    const live = (await store.listSteps(requestId)).find((s) => s.stepId === step.stepId)!;
    if (live.status !== 'ready') return { stoppedAt: live };

    const outcome = await executeStep(deps(), { requestId, stepId: step.stepId, attempt: 1 });
    if (outcome.kind === 'settled' && outcome.status === 'failed') return { stoppedAt: live };
  }
  return { stoppedAt: null };
}

/** Runs the request up to the point where the account is suspended. */
async function suspendedRequest() {
  const { requestId, steps } = await submit();
  await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
  return { requestId, steps };
}

// ------------------------------------------------------------------- AC-2

describe('AC-2: suspension precedes every destructive step', () => {
  it('suspends first, and deletes nothing on the way there', async () => {
    const { requestId, steps } = await submit();

    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });

    expect(directory.suspended).toBe(true);
    expect(directory.countCalls('deleteUser')).toBe(0);
    expect(directory.countCalls('removeMember')).toBe(0);
  });

  it('leaves the account suspended but intact when the request halts', async () => {
    const { requestId, steps } = await suspendedRequest();

    const live = await store.listSteps(requestId);
    expect(live.find((s) => s.name === 'suspend-user')!.status).toBe('succeeded');
    expect(directory.present).toBe(true);
    expect(directory.memberships.size).toBe(1);
    expect((await store.getRequest(requestId))!.status).toBe('running');
  });
});

// ------------------------------------------------------------------- AC-3

describe('AC-3: deletion always requires two-party approval', () => {
  it('persists the delete step as requiring approval under the default policy', async () => {
    const { requestId } = await submit();

    const remove = (await store.listSteps(requestId)).find((s) => s.name === 'delete-user')!;
    expect(remove.requiresApproval).toBe(true);
  });

  it('still requires approval when the policy explicitly disables it', async () => {
    const permissive: ApprovalPolicy = {
      ...DEFAULT_POLICY,
      delete: { 'delete-user': { requiresApproval: false, approverRole: 'approver' } },
    };

    const { requestId } = await submit(permissive);

    const remove = (await store.listSteps(requestId)).find((s) => s.name === 'delete-user')!;
    expect(remove.requiresApproval).toBe(true);
  });

  it('still requires approval when the policy says nothing at all', async () => {
    const silent: ApprovalPolicy = { ...DEFAULT_POLICY, delete: {} };

    const { requestId } = await submit(silent);

    const remove = (await store.listSteps(requestId)).find((s) => s.name === 'delete-user')!;
    expect(remove.requiresApproval).toBe(true);
    expect(resolveStepPolicy({}, 'delete-user').approverRole).toBe('admin');
  });

  it('halts rather than deleting when the plan reaches the delete step', async () => {
    const permissive: ApprovalPolicy = {
      ...DEFAULT_POLICY,
      delete: { 'delete-user': { requiresApproval: false, approverRole: 'approver' } },
    };
    const { requestId, steps } = await submit(permissive);

    await drive(requestId, steps);

    expect(directory.present).toBe(true);
    const remove = (await store.listSteps(requestId)).find((s) => s.name === 'delete-user')!;
    expect(remove.status).toBe('awaiting_approval');
    expect((await store.getRequest(requestId))!.status).toBe('awaiting_approval');
  });
});

// --------------------------------------------------------------- AC-4/5/6

describe('AC-4: cancelling appends a compensating step rather than terminating', () => {
  it('appends unsuspend-user and keeps the request in flight', async () => {
    const { requestId } = await suspendedRequest();

    const result = await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'the leaver is staying after all',
    });

    expect(result.appended).toBe(true);
    expect((await store.getRequest(requestId))!.status).toBe('running');
    expect(result.step!.status).toBe('ready');
  });

  it('stops every step the plan had not started', async () => {
    const { requestId } = await suspendedRequest();

    await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'cancelled',
    });

    const live = await store.listSteps(requestId);
    expect(live.filter((s) => s.status === 'pending')).toHaveLength(0);
    expect(live.find((s) => s.name === 'delete-user')!.status).toBe('skipped');
  });

  it('appends the step at the end of the plan, so it runs last', async () => {
    const { requestId } = await suspendedRequest();

    await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'cancelled',
    });

    const live = await store.listSteps(requestId);
    const appended = live[live.length - 1]!;
    expect(appended.name).toBe(COMPENSATING_STEP);
    expect(appended.ordinal).toBe(live.length - 1);
  });

  it('is idempotent: a repeated cancellation appends nothing further', async () => {
    const { requestId } = await suspendedRequest();
    const args = { requestId, stepName: COMPENSATING_STEP, actor: ACTOR, reason: 'cancelled' };

    const first = await store.appendCompensatingStep(args);
    const second = await store.appendCompensatingStep(args);

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(
      (await store.listSteps(requestId)).filter((s) => s.name === COMPENSATING_STEP),
    ).toHaveLength(1);
  });

  it('refuses to compensate a request that already finished', async () => {
    const { requestId } = await suspendedRequest();
    await store.cancelRequest({ requestId, actor: ACTOR, reason: 'terminated directly' });

    const result = await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'too late',
    });

    expect(result.appended).toBe(false);
  });
});

describe('AC-5: the request reaches cancelled only once the account is active again', () => {
  it('settles as cancelled after the unsuspend step succeeds', async () => {
    const { requestId } = await suspendedRequest();
    expect(directory.suspended).toBe(true);

    const { step } = await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'the leaver is staying after all',
    });
    await executeStep(deps(), { requestId, stepId: step!.stepId, attempt: 1 });

    expect(directory.suspended).toBe(false);
    expect((await store.getRequest(requestId))!.status).toBe('cancelled');
  });

  it('does not report cancelled while the compensation is still outstanding', async () => {
    const { requestId } = await suspendedRequest();

    await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'cancelled',
    });

    expect((await store.getRequest(requestId))!.status).toBe('running');
    expect(directory.suspended).toBe(true);
  });

  it('does not report succeeded, even though the plan ran to its end', async () => {
    const { requestId } = await suspendedRequest();
    const { step } = await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'cancelled',
    });

    await executeStep(deps(), { requestId, stepId: step!.stepId, attempt: 1 });

    const request = (await store.getRequest(requestId))!;
    expect(request.status).not.toBe('succeeded');
    expect(request.status).toBe('cancelled');
    expect(directory.present).toBe(true);
  });
});

describe('AC-6: a failed compensation fails the request, never cancels it', () => {
  it('leaves the request failed with the account still suspended', async () => {
    const { requestId } = await suspendedRequest();
    const { step } = await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'cancelled',
    });

    directory.failures.set(
      'setSuspended:false',
      new WorkspaceError('cannot unsuspend a deleted account', 'terminal', 400, 'users.update'),
    );
    await executeStep(deps(), { requestId, stepId: step!.stepId, attempt: 1 });

    const request = (await store.getRequest(requestId))!;
    expect(request.status).toBe('failed');
    expect(request.status).not.toBe('cancelled');
    expect(directory.suspended).toBe(true);
  });

  it('records the error on the compensating step', async () => {
    const { requestId } = await suspendedRequest();
    const { step } = await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'cancelled',
    });

    directory.failures.set(
      'setSuspended:false',
      new WorkspaceError('cannot unsuspend a deleted account', 'terminal', 400, 'users.update'),
    );
    await executeStep(deps(), { requestId, stepId: step!.stepId, attempt: 1 });

    const live = (await store.listSteps(requestId)).find((s) => s.stepId === step!.stepId)!;
    expect(live.status).toBe('failed');
    expect(live.error).not.toBeNull();
    expect(live.error!.message).toContain('cannot unsuspend');
    expect(live.error!.class).toBe('terminal');
  });
});

// ------------------------------------------------------------------- AC-9

describe('AC-9: every step records the user, the actor and the outcome', () => {
  it('audits each offboarding step with all three', async () => {
    const { requestId, steps } = await submit();
    await drive(requestId, steps);

    const events = await store.listAudit(requestId);
    const stepEvents = events.filter((e) => e.stepId !== null && e.action.startsWith('step.'));

    expect(stepEvents.length).toBeGreaterThan(0);
    for (const event of stepEvents) {
      expect(event.targetUser).toBe(TARGET);
      expect(event.actor.email).toBeTruthy();
      expect(['success', 'failure', 'denied']).toContain(event.outcome);
    }
  });

  it('names the human behind every automated offboarding step', async () => {
    const { requestId, steps } = await submit();
    await drive(requestId, steps);

    const systemEvents = (await store.listAudit(requestId)).filter((e) => e.actor.kind === 'system');

    expect(systemEvents.length).toBeGreaterThan(0);
    for (const event of systemEvents) expect(event.actor.onBehalfOf).toBe(OPERATOR);
  });

  it('audits the compensating step too, including who asked for it', async () => {
    const { requestId } = await suspendedRequest();
    const { step } = await store.appendCompensatingStep({
      requestId,
      stepName: COMPENSATING_STEP,
      actor: ACTOR,
      reason: 'the leaver is staying after all',
    });
    await executeStep(deps(), { requestId, stepId: step!.stepId, attempt: 1 });

    const events = await store.listAudit(requestId);

    const asked = events.find((e) => e.action === 'request.cancellation_requested')!;
    expect(asked.actor.email).toBe(OPERATOR);
    expect(asked.targetUser).toBe(TARGET);
    expect(JSON.stringify(asked.after)).toContain('the leaver is staying after all');

    const ran = events.filter((e) => e.stepId === step!.stepId && e.action === 'step.succeeded');
    expect(ran).toHaveLength(1);
    expect(ran[0]!.targetUser).toBe(TARGET);

    const settled = events.find((e) => e.action === 'request.cancelled')!;
    expect(settled).toBeDefined();
  });
});
