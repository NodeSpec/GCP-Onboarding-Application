import { Firestore, Timestamp } from '@google-cloud/firestore';
import { randomBytes } from 'node:crypto';
import {
  COLLECTIONS,
  CredentialStore,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type KeyProvider,
  type LifecycleStep,
  type ScheduleAt,
} from '@lifecycle/shared';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advance } from './advance.js';
import { executeStep } from './executor.js';
import { taskRoutes } from '../routes/tasks.js';
import { useNotificationSender } from '../phases/notify.js';
import type { DeliveryReceipt, Message, NotificationSender } from '../notify/sender.js';
import '../phases/create.js';
import '../phases/notify.js';

/**
 * TC-REQ-002-7 and TC-REQ-002-8: the expiry that closes the pull-only gap in
 * two-party approval, and the proof that a request with no approvals anywhere
 * needs no human after submission.
 *
 * Against the emulator because the expiry decision is transactional by design:
 * the task fires unconditionally hours after the halt, and whether anything
 * expires is decided against the step's live status inside the transaction. A
 * fake would prove the fake's race semantics, not Firestore's.
 *
 * The firing itself is exercised over HTTP through the real /tasks route,
 * because the criterion's "the task is a no-op" is a claim about what Cloud
 * Tasks observes, and Cloud Tasks observes a status code.
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
const TARGET = 'grace.hopper@company.com';

/** Records enqueues instead of reaching Cloud Tasks. */
class RecordingDispatcher {
  steps: { requestId: string; stepId: string; idempotencyKey: string }[] = [];
  notifications: { requestId: string; stepId: string }[] = [];
  expiries: { requestId: string; stepId: string; fireAt: ScheduleAt }[] = [];

  async enqueueStep(input: { requestId: string; stepId: string; idempotencyKey: string }) {
    this.steps.push(input);
  }

  async enqueueApproverNotification(input: { requestId: string; stepId: string }) {
    this.notifications.push(input);
  }

  async enqueueApprovalExpiry(input: { requestId: string; stepId: string; fireAt: ScheduleAt }) {
    this.expiries.push(input);
  }

  reset() {
    this.steps = [];
    this.notifications = [];
    this.expiries = [];
  }
}

class RecordingSender implements NotificationSender {
  sent: Message[] = [];
  private next = 0;

  async send(message: Message): Promise<DeliveryReceipt> {
    this.sent.push(message);
    this.next += 1;
    return { deliveryId: `delivery-${this.next}`, bounceReportingAvailable: false };
  }
}

const directory = {
  async getUser(primaryEmail: string) {
    return { primaryEmail, changePasswordAtNextLogin: true };
  },
  async resetPassword() {},
  generateInitialPassword: () => 'never-used-here',
};

const dispatcher = new RecordingDispatcher();
const sender = new RecordingSender();

function deps() {
  return {
    store,
    directory: directory as never,
    credentials,
    advance: (requestId: string, completedStepId: string) =>
      advance({ store, dispatcher }, requestId, completedStepId),
  };
}

// The /tasks surface, over real HTTP, minus the caller check which is proven
// in the taskAuth suite.
let server: Server;
let base: string;

beforeAll(async () => {
  useNotificationSender(sender);
  const app = express();
  app.use(express.json());
  app.use(
    '/tasks',
    taskRoutes({
      ...deps(),
      notifyApprovers: async () => ({ notified: [] }),
    }),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

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
afterEach(async () => {
  dispatcher.reset();
  await wipe();
});

const EXPIRING: ApprovalPolicy = {
  ...DEFAULT_POLICY,
  notify: {
    'send-welcome-letter': { requiresApproval: true, approverRole: 'approver', expiryHours: 4 },
  },
};

const PAYLOAD = {
  primaryEmail: TARGET,
  givenName: 'Grace',
  familyName: 'Hopper',
  notificationEmail: 'grace.personal@example.com',
  regenerate: false,
};

/**
 * Drives a notify request up to its gated send step, which halts. Returns the
 * halted step. The gate sits on the LAST step so the halt goes through
 * advance(), which is where the worker-side expiry scheduling lives.
 */
async function haltedAtSend(policy: ApprovalPolicy = EXPIRING) {
  await credentials.stash({
    requestId: 'origin-create',
    primaryEmail: TARGET,
    password: 'stored-otp',
    ttlHours: 72,
  });

  const documents = buildNewRequest({
    phase: 'notify',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload: PAYLOAD,
    plan: stepPlanFor('notify', PAYLOAD),
    policy,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);

  const requestId = documents.request.requestId;
  for (const step of documents.steps.slice(0, 2)) {
    await executeStep(deps(), { requestId, stepId: step.stepId, attempt: 1 });
  }

  const sendStep = documents.steps.find((s) => s.name === 'send-welcome-letter')!;
  return { requestId, stepId: sendStep.stepId };
}

async function stepOf(requestId: string, stepId: string): Promise<LifecycleStep> {
  const snap = await db
    .collection(COLLECTIONS.requests)
    .doc(requestId)
    .collection(COLLECTIONS.steps)
    .doc(stepId)
    .get();
  return snap.data() as LifecycleStep;
}

const fire = (requestId: string, stepId: string) =>
  fetch(`${base}/tasks/expire-approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, stepId }),
  });

describe('AC-7: a halt with an expiry configured schedules the firing', () => {
  it('schedules one expiry task for the expiry instant', async () => {
    const before = Date.now();
    const { requestId, stepId } = await haltedAtSend();

    expect(dispatcher.expiries).toHaveLength(1);
    expect(dispatcher.expiries[0]).toMatchObject({ requestId, stepId });

    // The instant is fixed at the halt, not left for a sweep to discover.
    const fireAt = dispatcher.expiries[0]!.fireAt;
    const millis = fireAt instanceof Date ? fireAt.getTime() : fireAt.toMillis();
    expect(millis).toBeGreaterThanOrEqual(before + 4 * 3_600_000);
    expect(millis).toBeLessThanOrEqual(Date.now() + 4 * 3_600_000);
  });

  it('schedules nothing when the policy sets no expiry', async () => {
    const noExpiry: ApprovalPolicy = {
      ...DEFAULT_POLICY,
      notify: { 'send-welcome-letter': { requiresApproval: true, approverRole: 'approver' } },
    };

    const { stepId } = await haltedAtSend(noExpiry);

    // Halted, notified, but no clock running: without an expiry configured the
    // approval waits indefinitely, which is the tenant's stated choice.
    expect(dispatcher.notifications).toHaveLength(1);
    expect(dispatcher.expiries).toEqual([]);
    void stepId;
  });
});

describe('AC-7: the firing rejects a still-pending approval', () => {
  it('terminates the request in rejected with reason approval_expired', async () => {
    const { requestId, stepId } = await haltedAtSend();

    const res = await fire(requestId, stepId);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'expired' });

    const request = (await store.getRequest(requestId))!;
    const step = await stepOf(requestId, stepId);
    expect(request.status).toBe('rejected');
    expect(step.status).toBe('failed');
    expect(step.error).toMatchObject({ code: 'approval_expired', class: 'terminal' });
  });

  it('writes an audit event carrying the reason, with no invented approver', async () => {
    const { requestId, stepId } = await haltedAtSend();

    await fire(requestId, stepId);

    const events = await store.listAudit(requestId);
    const expired = events.find((e) => e.action === 'approval.expired');
    expect(expired).toBeDefined();
    expect(expired!.after).toMatchObject({ reason: 'approval_expired', requestStatus: 'rejected' });

    // Nobody decided, so no ApprovalRecord exists. A synthetic system
    // "approver" would make the trail assert a person who never acted.
    expect((await stepOf(requestId, stepId)).approval).toBeNull();
  });

  it('sends nothing after expiring: the gated step never runs', async () => {
    const { requestId, stepId } = await haltedAtSend();
    const before = sender.sent.length;

    await fire(requestId, stepId);
    // A stale execute-step delivery arriving after the expiry finds the step
    // 'failed', which is not claimable.
    const outcome = await executeStep(deps(), { requestId, stepId, attempt: 1 });

    expect(outcome).toMatchObject({ kind: 'not-claimable' });
    expect(sender.sent.length).toBe(before);
  });
});

describe('AC-7: a firing after the decision is a no-op', () => {
  it('does nothing when the step was approved in time', async () => {
    const { requestId, stepId } = await haltedAtSend();
    await store.decideStep({
      requestId,
      stepId,
      decision: 'approved',
      approver: { kind: 'human', email: 'approver@company.com' },
      justification: 'verified with the requester',
    });

    const res = await fire(requestId, stepId);

    expect(await res.json()).toMatchObject({ status: 'noop', observedStep: 'ready' });
    // The approval stands. An expiry that could undo a decision made in time
    // would make every approval provisional until the task fired.
    expect((await store.getRequest(requestId))!.status).toBe('running');
    expect((await stepOf(requestId, stepId)).status).toBe('ready');
  });

  it('does nothing when the step was rejected in time', async () => {
    const { requestId, stepId } = await haltedAtSend();
    await store.decideStep({
      requestId,
      stepId,
      decision: 'rejected',
      approver: { kind: 'human', email: 'approver@company.com' },
      justification: 'address could not be verified',
    });

    await fire(requestId, stepId);

    // Rejected by a human, and it stays that way: the human's justification is
    // the record, not an approval_expired overwrite.
    const step = await stepOf(requestId, stepId);
    expect(step.approval).toMatchObject({ decision: 'rejected' });
    expect(step.error).toBeNull();
  });

  it('does nothing for a request that no longer exists', async () => {
    const res = await fire('never-existed', '000-nope');

    // 200, not an error: the task outlived its subject and retrying cannot
    // change that. A 500 here would burn the queue's retry budget on a ghost.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'noop' });
  });

  it('expires exactly once under concurrent firings', async () => {
    // Cloud Tasks delivers at least once. Two deliveries racing must produce
    // one expiry and one no-op, not two audit events for one rejection.
    const { requestId, stepId } = await haltedAtSend();

    const responses = await Promise.all([fire(requestId, stepId), fire(requestId, stepId)]);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ status: string }>));

    expect(bodies.map((b) => b.status).sort()).toEqual(['expired', 'noop']);
    const events = await store.listAudit(requestId);
    expect(events.filter((e) => e.action === 'approval.expired')).toHaveLength(1);
  });
});

describe('AC-8: with approval off everywhere, no human acts after submission', () => {
  it('runs a request end to end driven only by the task queue', async () => {
    await credentials.stash({
      requestId: 'origin-create',
      primaryEmail: TARGET,
      password: 'stored-otp',
      ttlHours: 72,
    });

    // DEFAULT_POLICY has no approvals for the notify phase. The submission is
    // the single human act; everything after is the queue pump below, which
    // stands in for Cloud Tasks delivering what advance() enqueues.
    const documents = buildNewRequest({
      phase: 'notify',
      targetUser: TARGET,
      requestedBy: OPERATOR,
      payload: PAYLOAD,
      plan: stepPlanFor('notify', PAYLOAD),
      policy: DEFAULT_POLICY,
    });
    await store.createRequest(documents, ACTOR);
    const started = await store.startFirstStep(documents.request.requestId, ACTOR);
    const requestId = documents.request.requestId;

    await dispatcher.enqueueStep({
      requestId,
      stepId: started.step.stepId,
      idempotencyKey: started.step.idempotencyKey,
    });

    let guard = 0;
    while (dispatcher.steps.length > 0 && guard < 20) {
      const task = dispatcher.steps.shift()!;
      await executeStep(deps(), { requestId: task.requestId, stepId: task.stepId, attempt: 1 });
      guard += 1;
    }

    expect((await store.getRequest(requestId))!.status).toBe('succeeded');
    expect(sender.sent.at(-1)!.to).toEqual(['grace.personal@example.com']);

    // No human interaction beyond submission: nothing halted, nobody was asked
    // to approve, and no expiry clock was ever started.
    expect(dispatcher.notifications).toEqual([]);
    expect(dispatcher.expiries).toEqual([]);
    const actions = (await store.listAudit(requestId)).map((e) => e.action);
    expect(actions).not.toContain('step.awaiting_approval');
    expect(actions.filter((a) => a === 'step.approved' || a === 'step.rejected')).toEqual([]);
  });
});
