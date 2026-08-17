import { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type EnqueueStepInput,
  type LifecycleStep,
  type TaskDispatcher,
} from '@lifecycle/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advance } from './advance.js';

/**
 * TC-REQ-016-6 and TC-REQ-016-7, against the Firestore emulator.
 *
 * advance() is where the executor decides what happens after a step finishes,
 * and its correctness is entirely about what survives a redelivery. That cannot
 * be proven against a fake store: the guard it relies on is transitionStep's
 * read-and-compare inside a real Firestore transaction, so a fake would confirm
 * the fake's guard. Only the dispatcher is substituted, because Cloud Tasks is
 * the one participant whose behaviour is not under test here.
 *
 * Run with `npm run test:emulator`.
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
  groups: ['engineering@company.com'],
};

class RecordingDispatcher implements TaskDispatcher {
  steps: EnqueueStepInput[] = [];
  notifications: { requestId: string; stepId: string }[] = [];
  expiries: { requestId: string; stepId: string }[] = [];
  /** Set to make the next notification enqueue throw, as Cloud Tasks might. */
  failNotification = false;

  async enqueueStep(input: EnqueueStepInput) {
    this.steps.push(input);
  }

  async enqueueApproverNotification(input: { requestId: string; stepId: string }) {
    if (this.failNotification) {
      this.failNotification = false;
      throw new Error('cloud tasks unavailable');
    }
    this.notifications.push(input);
  }

  async enqueueApprovalExpiry(input: { requestId: string; stepId: string }) {
    this.expiries.push({ requestId: input.requestId, stepId: input.stepId });
  }
}

let dispatcher: RecordingDispatcher;

/**
 * A request whose first step has already succeeded, so advance() has something
 * to move on from. Returns the request id and its steps in order.
 */
async function running(policy: ApprovalPolicy = DEFAULT_POLICY) {
  const documents = buildNewRequest({
    phase: 'create',
    targetUser: PAYLOAD.primaryEmail,
    requestedBy: 'operator@company.com',
    payload: PAYLOAD,
    plan: stepPlanFor('create', PAYLOAD),
    policy,
  });

  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);

  const first = documents.steps[0]!;
  await store.transitionStep({
    requestId: documents.request.requestId,
    stepId: first.stepId,
    expectedFrom: 'ready',
    to: 'running',
    audit: { actor: ACTOR, action: 'step.running' },
  });
  await store.transitionStep({
    requestId: documents.request.requestId,
    stepId: first.stepId,
    expectedFrom: 'running',
    to: 'succeeded',
    audit: { actor: ACTOR, action: 'step.succeeded' },
  });

  return { requestId: documents.request.requestId, steps: documents.steps };
}

/** Requires approval on the SECOND step, which is the one advance() picks up. */
function haltSecond(): ApprovalPolicy {
  return {
    ...DEFAULT_POLICY,
    create: { 'create-user': { requiresApproval: true, approverRole: 'approver' } },
  };
}

async function stepsOf(requestId: string): Promise<LifecycleStep[]> {
  return store.listSteps(requestId);
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
  dispatcher = new RecordingDispatcher();
  await wipe();
});

dispatcher = new RecordingDispatcher();

describe('AC-6: the next step is dispatched or halted per the snapshotted policy', () => {
  it('releases and enqueues the next step when no approval is required', async () => {
    const { requestId, steps } = await running();

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    const after = await stepsOf(requestId);
    expect(after[1]!.status).toBe('ready');
    expect(dispatcher.steps).toEqual([
      { requestId, stepId: steps[1]!.stepId, idempotencyKey: steps[1]!.idempotencyKey },
    ]);
    expect(dispatcher.notifications).toHaveLength(0);
  });

  it('leaves the steps after the next one untouched', async () => {
    const { requestId, steps } = await running();

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    const after = await stepsOf(requestId);
    expect(after.slice(2).every((s) => s.status === 'pending')).toBe(true);
    expect(dispatcher.steps).toHaveLength(1);
  });

  it('halts the next step when the snapshot requires approval', async () => {
    const { requestId, steps } = await running(haltSecond());

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    const after = await stepsOf(requestId);
    expect(after[1]!.status).toBe('awaiting_approval');
    expect((await store.getRequest(requestId))!.status).toBe('awaiting_approval');
    // Halted means halted: no execution task exists for it.
    expect(dispatcher.steps).toHaveLength(0);
  });

  it('succeeds the request when no pending step remains', async () => {
    const { requestId, steps } = await running();

    // Drive every remaining step to succeeded, then advance past the last one.
    for (const step of steps.slice(1)) {
      await store.transitionStep({
        requestId,
        stepId: step.stepId,
        expectedFrom: 'pending',
        to: 'skipped',
        audit: { actor: ACTOR, action: 'step.skipped' },
      });
    }

    await advance({ store, dispatcher }, requestId, steps.at(-1)!.stepId);

    expect((await store.getRequest(requestId))!.status).toBe('succeeded');
    expect(dispatcher.steps).toHaveLength(0);
  });
});

describe('AC-7: a halt cannot be committed without its notification record', () => {
  it('writes the notification record in the same transaction as the halt', async () => {
    const { requestId, steps } = await running(haltSecond());

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    const halted = (await stepsOf(requestId))[1]!;
    expect(halted.status).toBe('awaiting_approval');
    expect(halted.approverNotification).not.toBeNull();
    // Unsent: the record is the outbox entry, REQ-032 stamps sentAt on delivery.
    expect(halted.approverNotification!.sentAt).toBeNull();
  });

  it('enqueues the notification after the halt commits', async () => {
    const { requestId, steps } = await running(haltSecond());

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    expect(dispatcher.notifications).toEqual([{ requestId, stepId: steps[1]!.stepId }]);
  });

  it('re-enqueues the notification when a redelivery finds the halt already applied', async () => {
    // The regression this exists for: the first delivery halts the step and
    // then dies before the enqueue. Cloud Tasks redelivers. If advance()
    // returned early on seeing the halt already applied, the step would sit
    // awaiting approval forever with nobody told.
    const { requestId, steps } = await running(haltSecond());

    dispatcher.failNotification = true;
    await expect(advance({ store, dispatcher }, requestId, steps[0]!.stepId)).rejects.toThrow(
      'cloud tasks unavailable',
    );
    expect(dispatcher.notifications).toHaveLength(0);
    expect((await stepsOf(requestId))[1]!.status).toBe('awaiting_approval');

    // The redelivery.
    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    expect(dispatcher.notifications).toEqual([{ requestId, stepId: steps[1]!.stepId }]);
  });

  it('a redelivery does not step over the halted step and dispatch the next one', async () => {
    // The approval bypass. Selecting "the next step still pending" skips a step
    // sitting in awaiting_approval, so a redelivered task would release the step
    // AFTER the halt and execute work the approver never allowed. The halted
    // step is the one the plan is at, whatever its status.
    const { requestId, steps } = await running(haltSecond());
    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    expect(dispatcher.steps).toHaveLength(0);
    const after = await stepsOf(requestId);
    expect(after[1]!.status).toBe('awaiting_approval');
    expect(after.slice(2).every((s) => s.status === 'pending')).toBe(true);
  });

  it('does not re-enqueue for a step another delivery moved elsewhere', async () => {
    const { requestId, steps } = await running(haltSecond());
    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    // The step is decided between the two deliveries.
    await store.decideStep({
      requestId,
      stepId: steps[1]!.stepId,
      decision: 'approved',
      approver: { kind: 'human', email: 'approver@company.com' },
      justification: 'checked',
    });
    dispatcher.notifications = [];

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    // Nothing further: the approval owns what happens next.
    expect(dispatcher.notifications).toHaveLength(0);
  });

  it('writes no notification record when the next step is dispatched instead', async () => {
    const { requestId, steps } = await running();

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    expect((await stepsOf(requestId))[1]!.approverNotification).toBeNull();
  });
});

describe('approval expiry scheduling', () => {
  it('schedules an expiry when the policy configures one', async () => {
    const policy: ApprovalPolicy = {
      ...DEFAULT_POLICY,
      create: { 'create-user': { requiresApproval: true, approverRole: 'approver', expiryHours: 24 } },
    };
    const { requestId, steps } = await running(policy);

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    expect(dispatcher.expiries).toEqual([{ requestId, stepId: steps[1]!.stepId }]);
  });

  it('schedules no expiry when the policy configures none', async () => {
    const { requestId, steps } = await running(haltSecond());

    await advance({ store, dispatcher }, requestId, steps[0]!.stepId);

    expect(dispatcher.expiries).toHaveLength(0);
  });
});
