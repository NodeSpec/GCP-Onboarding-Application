import { Firestore, Timestamp } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type AuditActor,
  type AuditEvent,
  type LifecycleStep,
} from '@lifecycle/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WorkspaceError } from '../workspace/directoryClient.js';
import { registerHandler, type StepContext, type StepResult } from './handler.js';
import { executeStep } from './executor.js';

/**
 * TC-REQ-016-1, 2, 4 and 5: what survives a delivery that goes wrong.
 *
 * Every one of these is about transactional behaviour under a redelivery or a
 * crash, so a fake store would only prove the fake. The handler is the one
 * thing substituted: it is registered once here and then told what to do per
 * test, which lets a step hang, fail transiently, or fail terminally on demand.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const ACTOR: AuditActor = { kind: 'human', email: 'operator@company.com' };

const PAYLOAD = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  groups: [],
};

/** What the registered handler should do on its next call. */
let behaviour: (ctx: StepContext) => Promise<StepResult> = async () => ({ status: 'succeeded' });
let executions = 0;

registerHandler({
  name: 'validate-request',
  async execute(ctx) {
    executions += 1;
    return behaviour(ctx);
  },
});

let advanced: string[] = [];

function deps(overrides: { leaseSeconds?: number; maxAttempts?: number } = {}) {
  return {
    store,
    directory: {} as never,
    credentials: {} as never,
    advance: async (_requestId: string, stepId: string) => {
      advanced.push(stepId);
    },
    ...overrides,
  };
}

async function ready() {
  const documents = buildNewRequest({
    phase: 'create',
    targetUser: PAYLOAD.primaryEmail,
    requestedBy: 'operator@company.com',
    payload: PAYLOAD,
    plan: stepPlanFor('create', PAYLOAD),
    policy: DEFAULT_POLICY,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);
  return { requestId: documents.request.requestId, stepId: documents.steps[0]!.stepId };
}

async function stepOf(requestId: string, stepId: string): Promise<LifecycleStep> {
  return (await store.listSteps(requestId)).find((s) => s.stepId === stepId)!;
}

async function auditOf(requestId: string): Promise<AuditEvent[]> {
  return store.listAudit(requestId);
}

async function wipe() {
  for (const collection of [COLLECTIONS.requests, COLLECTIONS.audit]) {
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
afterEach(async () => {
  behaviour = async () => ({ status: 'succeeded' });
  executions = 0;
  advanced = [];
  await wipe();
});

describe('AC-2: a duplicate delivery executes exactly once', () => {
  it('runs the handler once across two deliveries of the same step', async () => {
    const { requestId, stepId } = await ready();

    const first = await executeStep(deps(), { requestId, stepId, attempt: 1 });
    const second = await executeStep(deps(), { requestId, stepId, attempt: 1 });

    expect(first).toEqual({ kind: 'settled', status: 'succeeded' });
    expect(second.kind).toBe('not-claimable');
    expect(executions).toBe(1);
  });

  it('the loser of a concurrent race observes a non-ready status and does nothing', async () => {
    const { requestId, stepId } = await ready();

    // Hold the step inside the handler so both deliveries genuinely overlap.
    // `started` is what makes this deterministic: the second delivery is not
    // launched until the first is provably inside the handler, holding the claim.
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inHandler = new Promise<void>((resolve) => {
      started = resolve;
    });
    behaviour = async () => {
      started();
      await gate;
      return { status: 'succeeded' };
    };

    const a = executeStep(deps(), { requestId, stepId, attempt: 1 });
    await inHandler;
    const b = await executeStep(deps(), { requestId, stepId, attempt: 1 });
    release();
    const settled = await a;

    expect(b).toMatchObject({ kind: 'not-claimable', observed: 'running' });
    expect(settled).toEqual({ kind: 'settled', status: 'succeeded' });
    expect(executions).toBe(1);
    // The loser dispatched nothing either: no side effects at all.
    expect(advanced).toEqual([stepId]);
  });

  it('a delivery for an already-succeeded step is acknowledged, not re-run', async () => {
    const { requestId, stepId } = await ready();
    await executeStep(deps(), { requestId, stepId, attempt: 1 });

    const again = await executeStep(deps(), { requestId, stepId, attempt: 2 });

    expect(again).toMatchObject({ kind: 'not-claimable', observed: 'succeeded' });
    expect(executions).toBe(1);
  });
});

describe('AC-1: an instance killed mid-step resumes on the next delivery', () => {
  it('reclaims a step whose lease has expired and replays it', async () => {
    const { requestId, stepId } = await ready();

    // Simulate the kill: claim the step, then abandon it. The process that
    // claimed it never comes back, so the step sits 'running' forever.
    await store.claimStep({
      requestId,
      stepId,
      attempt: 1,
      leaseSeconds: 600,
      audit: { actor: ACTOR, action: 'step.claim' },
    });
    await db
      .collection(COLLECTIONS.requests)
      .doc(requestId)
      .collection(COLLECTIONS.steps)
      .doc(stepId)
      .update({ startedAt: Timestamp.fromMillis(Date.now() - 3_600_000) });

    const outcome = await executeStep(deps({ leaseSeconds: 60 }), { requestId, stepId, attempt: 2 });

    expect(outcome).toEqual({ kind: 'settled', status: 'succeeded' });
    expect(executions).toBe(1);
    expect((await stepOf(requestId, stepId)).status).toBe('succeeded');
  });

  it('refuses to reclaim a step whose lease is still live', async () => {
    const { requestId, stepId } = await ready();

    await store.claimStep({
      requestId,
      stepId,
      attempt: 1,
      leaseSeconds: 600,
      audit: { actor: ACTOR, action: 'step.claim' },
    });

    const outcome = await executeStep(deps({ leaseSeconds: 600 }), {
      requestId,
      stepId,
      attempt: 2,
    });

    // Slow is not dead. Stealing a live claim would run the step twice at once.
    expect(outcome).toMatchObject({ kind: 'not-claimable', observed: 'running' });
    expect(executions).toBe(0);
  });

  it('records the reclaim in the audit trail rather than hiding it', async () => {
    const { requestId, stepId } = await ready();
    await store.claimStep({
      requestId,
      stepId,
      attempt: 1,
      leaseSeconds: 600,
      audit: { actor: ACTOR, action: 'step.claim' },
    });
    await db
      .collection(COLLECTIONS.requests)
      .doc(requestId)
      .collection(COLLECTIONS.steps)
      .doc(stepId)
      .update({ startedAt: Timestamp.fromMillis(Date.now() - 3_600_000) });

    await executeStep(deps({ leaseSeconds: 60 }), { requestId, stepId, attempt: 2 });

    const claims = (await auditOf(requestId)).filter((e) => e.action === 'step.claim');
    expect(claims.some((e) => (e.after as { reclaimed: boolean }).reclaimed)).toBe(true);
  });

  it('skips no step: the plan is still complete after a reclaim', async () => {
    const { requestId, stepId } = await ready();
    await store.claimStep({
      requestId,
      stepId,
      attempt: 1,
      leaseSeconds: 600,
      audit: { actor: ACTOR, action: 'step.claim' },
    });
    await db
      .collection(COLLECTIONS.requests)
      .doc(requestId)
      .collection(COLLECTIONS.steps)
      .doc(stepId)
      .update({ startedAt: Timestamp.fromMillis(Date.now() - 3_600_000) });

    await executeStep(deps({ leaseSeconds: 60 }), { requestId, stepId, attempt: 2 });

    // The reclaimed step completed and handed on to the next one.
    expect(advanced).toEqual([stepId]);
  });
});

describe('AC-5: a step that exhausts its retry budget settles, it does not hang', () => {
  const transient = () => new WorkspaceError('rate limited', 'retryable', 429, 'users.insert');

  it('hands the step back to ready while budget remains', async () => {
    const { requestId, stepId } = await ready();
    behaviour = async () => {
      throw transient();
    };

    const outcome = await executeStep(deps({ maxAttempts: 3 }), { requestId, stepId, attempt: 1 });

    expect(outcome.kind).toBe('retry');
    // 'ready', not 'failed'. A step parked in 'failed' can never be claimed
    // again, which would make every transient error permanently fatal.
    expect((await stepOf(requestId, stepId)).status).toBe('ready');
    expect((await store.getRequest(requestId))!.status).toBe('running');
  });

  it('lets the redelivery claim the handed-back step and succeed', async () => {
    const { requestId, stepId } = await ready();
    behaviour = async () => {
      throw transient();
    };
    await executeStep(deps({ maxAttempts: 3 }), { requestId, stepId, attempt: 1 });

    behaviour = async () => ({ status: 'succeeded' });
    const outcome = await executeStep(deps({ maxAttempts: 3 }), { requestId, stepId, attempt: 2 });

    expect(outcome).toEqual({ kind: 'settled', status: 'succeeded' });
    expect((await stepOf(requestId, stepId)).status).toBe('succeeded');
  });

  it('settles the step and the request when the budget is spent', async () => {
    const { requestId, stepId } = await ready();
    behaviour = async () => {
      throw transient();
    };

    const outcome = await executeStep(deps({ maxAttempts: 3 }), { requestId, stepId, attempt: 3 });

    // Cloud Tasks gives up silently, so the last attempt has to settle both.
    expect(outcome).toEqual({ kind: 'settled', status: 'failed' });

    const step = await stepOf(requestId, stepId);
    expect(step.status).toBe('failed');
    expect(step.error).toMatchObject({ code: 'retry_budget_exhausted', class: 'retryable' });
    expect((await store.getRequest(requestId))!.status).toBe('failed');
  });

  it('dispatches no later step once the budget is spent', async () => {
    const { requestId, stepId } = await ready();
    behaviour = async () => {
      throw transient();
    };

    await executeStep(deps({ maxAttempts: 1 }), { requestId, stepId, attempt: 1 });

    expect(advanced).toEqual([]);
    const steps = await store.listSteps(requestId);
    expect(steps.slice(1).every((s) => s.status === 'pending')).toBe(true);
  });

  it('records the exhaustion in the audit trail, not just the error', async () => {
    const { requestId, stepId } = await ready();
    behaviour = async () => {
      throw transient();
    };

    await executeStep(deps({ maxAttempts: 2 }), { requestId, stepId, attempt: 2 });

    const failure = (await auditOf(requestId)).find((e) => e.action === 'step.failed')!;
    expect(failure.after).toMatchObject({ retryBudgetExhausted: true, attempt: 2, maxAttempts: 2 });
  });

  it('settles a terminal error immediately, whatever the budget', async () => {
    const { requestId, stepId } = await ready();
    behaviour = async () => {
      throw new WorkspaceError('bad request', 'terminal', 400, 'users.insert');
    };

    const outcome = await executeStep(deps({ maxAttempts: 5 }), { requestId, stepId, attempt: 1 });

    expect(outcome).toEqual({ kind: 'settled', status: 'failed' });
    expect((await store.getRequest(requestId))!.status).toBe('failed');
    expect(advanced).toEqual([]);
  });
});

describe('AC-4: a transition and its audit event land together or not at all', () => {
  it('rolls back the status change when the audit write fails', async () => {
    const { requestId, stepId } = await ready();
    const before = await stepOf(requestId, stepId);

    // The audit event carries a value Firestore refuses, so the write that
    // aborts the transaction is the AUDIT write, staged after the status update.
    // If the two were not in one transaction the status change would survive.
    await expect(
      store.transitionStep({
        requestId,
        stepId,
        expectedFrom: 'ready',
        to: 'running',
        audit: {
          actor: ACTOR,
          action: 'step.claim',
          // Firestore refuses nested arrays outright, so this is the AUDIT
          // write failing, staged after the status update.
          after: { poisoned: [[1]] as unknown as string },
        },
      }),
    ).rejects.toThrow();

    // Neither landed.
    expect((await stepOf(requestId, stepId)).status).toBe(before.status);
    expect(await auditOf(requestId)).toHaveLength(2); // creation + first dispatch only
  });

  it('writes both when the transaction succeeds', async () => {
    const { requestId, stepId } = await ready();

    await store.transitionStep({
      requestId,
      stepId,
      expectedFrom: 'ready',
      to: 'running',
      audit: { actor: ACTOR, action: 'step.claim' },
    });

    expect((await stepOf(requestId, stepId)).status).toBe('running');
    expect((await auditOf(requestId)).some((e) => e.action === 'step.claim')).toBe(true);
  });
});
