import { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  COMPENSATING_STEP,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type AuditActor,
  type EnqueueStepInput,
  type OperatorRole,
} from '@lifecycle/shared';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OperatorIdentity } from '../middleware/iapAuth.js';
import { requestRoutes } from './requests.js';

/**
 * TC-REQ-006-4: cancelling an offboarding appends a compensating step AND
 * dispatches it, rather than terminating the request directly.
 *
 * Over real HTTP against the emulator, because the criterion is about what the
 * operator-facing surface does. The append and the executor half are proven in
 * the worker's offboarding suite; what only this can show is that the route
 * takes the compensating branch, enqueues the step it created, and does not
 * answer 'cancelled' while the account is still suspended.
 *
 * The request is staged through the shared store rather than driven through the
 * worker: the worker is a separate package, and importing its executor here
 * would put its sources inside this one's compilation.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const OPERATOR = 'operator@company.com';
const ACTOR: AuditActor = { kind: 'human', email: OPERATOR };
const TARGET = 'ada.lovelace@company.com';

/** Records what the route enqueued instead of reaching Cloud Tasks. */
class RecordingDispatcher {
  steps: EnqueueStepInput[] = [];
  failNext = false;

  async enqueueStep(input: EnqueueStepInput) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('cloud tasks unavailable');
    }
    this.steps.push(input);
  }

  async enqueueApproverNotification() {}
  async enqueueApprovalExpiry() {}

  reset() {
    this.steps = [];
    this.failNext = false;
  }
}

const dispatcher = new RecordingDispatcher();

let identity: OperatorIdentity = { email: OPERATOR, subject: 'sub-1' };
let roles: OperatorRole[] = ['requester', 'approver', 'admin'];
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  app.use(
    '/api/requests',
    requestRoutes({
      store,
      loadPolicy: async () => DEFAULT_POLICY,
      dispatcher,
      resolver: { async rolesFor() { return roles; } },
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
  identity = { email: OPERATOR, subject: 'sub-1' };
  roles = ['requester', 'approver', 'admin'];
  dispatcher.reset();
  await wipe();
});

/** An offboarding request, optionally advanced past its suspend step. */
async function offboarding(options: { suspended: boolean; suspendSkipped?: boolean }) {
  const payload = { primaryEmail: TARGET };
  const documents = buildNewRequest({
    phase: 'delete',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload,
    plan: stepPlanFor('delete', payload),
    policy: DEFAULT_POLICY,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);

  const requestId = documents.request.requestId;
  const suspend = documents.steps.find((s) => s.name === 'suspend-user')!;

  if (options.suspended || options.suspendSkipped) {
    await store.claimStep({
      requestId,
      stepId: suspend.stepId,
      attempt: 1,
      leaseSeconds: 600,
      audit: { actor: ACTOR, action: 'step.claim' },
    });
    await store.transitionStep({
      requestId,
      stepId: suspend.stepId,
      expectedFrom: 'running',
      to: options.suspendSkipped ? 'skipped' : 'succeeded',
      audit: { actor: ACTOR, action: 'step.settled' },
    });
  }

  return { requestId, steps: documents.steps };
}

const cancel = (requestId: string, reason = 'the leaver is staying after all') =>
  fetch(`${base}/api/requests/${requestId}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });

describe('AC-4: cancelling a suspended offboarding appends and dispatches', () => {
  it('answers 202 with the compensating step it created', async () => {
    const { requestId } = await offboarding({ suspended: true });

    const res = await cancel(requestId);
    const body = (await res.json()) as {
      status: string;
      compensatingStep: { stepId: string; name: string };
      dispatch: string;
    };

    expect(res.status).toBe(202);
    expect(body.status).toBe('compensating');
    expect(body.compensatingStep.name).toBe(COMPENSATING_STEP);
    expect(body.dispatch).toBe('enqueued');
  });

  it('dispatches the step it appended, with the key persisted on it', async () => {
    const { requestId } = await offboarding({ suspended: true });

    await cancel(requestId);

    const appended = (await store.listSteps(requestId)).find((s) => s.name === COMPENSATING_STEP)!;
    expect(dispatcher.steps).toEqual([
      { requestId, stepId: appended.stepId, idempotencyKey: appended.idempotencyKey },
    ]);
  });

  it('does not terminate the request', async () => {
    const { requestId } = await offboarding({ suspended: true });

    await cancel(requestId);

    expect((await store.getRequest(requestId))!.status).toBe('running');
  });

  it('stops every step the plan had not started', async () => {
    const { requestId } = await offboarding({ suspended: true });

    await cancel(requestId);

    const live = await store.listSteps(requestId);
    expect(live.find((s) => s.name === 'delete-user')!.status).toBe('skipped');
    expect(live.filter((s) => s.status === 'pending')).toHaveLength(0);
  });

  it('is idempotent: a repeated cancellation redispatches the same step', async () => {
    const { requestId } = await offboarding({ suspended: true });

    await cancel(requestId);
    const second = await cancel(requestId);
    const body = (await second.json()) as { appended: boolean; status: string };

    expect(second.status).toBe(202);
    expect(body.appended).toBe(false);
    expect(
      (await store.listSteps(requestId)).filter((s) => s.name === COMPENSATING_STEP),
    ).toHaveLength(1);
    expect(dispatcher.steps).toHaveLength(2);
  });

  it('still appends when the enqueue fails, and says the dispatch was deferred', async () => {
    const { requestId } = await offboarding({ suspended: true });
    dispatcher.failNext = true;

    const res = await cancel(requestId);
    const body = (await res.json()) as { dispatch: string };

    expect(res.status).toBe(202);
    expect(body.dispatch).toBe('deferred');
    expect(
      (await store.listSteps(requestId)).find((s) => s.name === COMPENSATING_STEP)!.status,
    ).toBe('ready');
  });
});

describe('the compensating branch is taken only for work this request did', () => {
  it('terminates directly when nothing has been suspended yet', async () => {
    const { requestId } = await offboarding({ suspended: false });

    const res = await cancel(requestId);
    const body = (await res.json()) as { status: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe('cancelled');
    expect((await store.getRequest(requestId))!.status).toBe('cancelled');
    expect(dispatcher.steps).toHaveLength(0);
  });

  it('terminates directly when the suspend step was SKIPPED', async () => {
    const { requestId } = await offboarding({ suspended: false, suspendSkipped: true });

    const res = await cancel(requestId);

    expect(res.status).toBe(200);
    expect(
      (await store.listSteps(requestId)).some((s) => s.name === COMPENSATING_STEP),
    ).toBe(false);
  });

  it('refuses a request that has already finished', async () => {
    const { requestId } = await offboarding({ suspended: false });
    await cancel(requestId);

    const again = await cancel(requestId);

    expect(again.status).toBe(409);
  });
});

describe('the route validates and authorises like every other', () => {
  it('requires a reason', async () => {
    const { requestId } = await offboarding({ suspended: true });

    const res = await fetch(`${base}/api/requests/${requestId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '   ' }),
    });

    expect(res.status).toBe(400);
    expect(
      (await store.listSteps(requestId)).some((s) => s.name === COMPENSATING_STEP),
    ).toBe(false);
  });

  it('returns 404 for a request that does not exist', async () => {
    expect((await cancel('no-such-request')).status).toBe(404);
  });

  it('refuses an identity without the requester role', async () => {
    const { requestId } = await offboarding({ suspended: true });
    roles = [];

    expect((await cancel(requestId)).status).toBe(403);
  });

  it('records the operator and the reason in the audit trail', async () => {
    const { requestId } = await offboarding({ suspended: true });

    await cancel(requestId, 'the leaver is staying after all');

    const event = (await store.listAudit(requestId)).find(
      (e) => e.action === 'request.cancellation_requested',
    )!;
    expect(event.actor.email).toBe(OPERATOR);
    expect(event.targetUser).toBe(TARGET);
    expect(JSON.stringify(event.after)).toContain('the leaver is staying after all');
  });
});
