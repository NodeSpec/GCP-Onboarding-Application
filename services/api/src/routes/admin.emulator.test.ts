import { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type AuditEvent,
  type EnqueueStepInput,
  type TaskDispatcher,
} from '@lifecycle/shared';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BindingRoleResolver } from '../roles.js';
import type { OperatorIdentity } from '../middleware/iapAuth.js';
import { adminRoutes } from './admin.js';

/**
 * TC-REQ-012-5: the three powers that make an admin an admin.
 *
 * Against the emulator with the real store, because the interesting parts are
 * transactional: cancelling has to stop the pending steps in the same
 * transaction as the request, and resuming has to move the failed step and the
 * request together or not at all.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const ADMIN = 'root@company.com';
const ACTOR: AuditActor = { kind: 'human', email: 'operator@company.com' };

const PAYLOAD = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  groups: ['engineering@company.com'],
};

/** An audit event as it appears on the wire: timestamp is an ISO string. */
type WireEvent = Omit<AuditEvent, 'timestamp'> & { timestamp: string };

class RecordingDispatcher implements TaskDispatcher {
  steps: EnqueueStepInput[] = [];
  async enqueueStep(input: EnqueueStepInput) {
    this.steps.push(input);
  }
  async enqueueApproverNotification(_input: { requestId: string; stepId: string }) {}
  async enqueueApprovalExpiry(_input: { requestId: string; stepId: string }) {}
}

let dispatcher = new RecordingDispatcher();
let identity: OperatorIdentity = { email: ADMIN, subject: 'sub-root' };

const resolver = new BindingRoleResolver(store, { bootstrapAdmins: [ADMIN] });

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
    '/api/admin',
    adminRoutes({ store, resolver, dispatcher: {
      enqueueStep: (i) => dispatcher.enqueueStep(i),
      enqueueApproverNotification: (i) => dispatcher.enqueueApproverNotification(i),
      enqueueApprovalExpiry: (i) => dispatcher.enqueueApprovalExpiry(i),
    } }),
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
  for (const collection of [COLLECTIONS.requests, COLLECTIONS.audit, COLLECTIONS.approvalPolicy]) {
    const snap = await db.collection(collection).get();
    await Promise.all(
      snap.docs.map(async (doc) => {
        const steps = await doc.ref.collection(COLLECTIONS.steps).get();
        await Promise.all(steps.docs.map((s) => s.ref.delete()));
        await doc.ref.delete();
      }),
    );
  }
  resolver.invalidate();
}

beforeAll(wipe);
afterEach(async () => {
  identity = { email: ADMIN, subject: 'sub-root' };
  dispatcher = new RecordingDispatcher();
  await wipe();
});

const as = (email: string) => {
  identity = { email, subject: `sub-${email}` };
};

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

/** A request with its first step released, ready to be cancelled. */
async function running() {
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
  return { requestId: documents.request.requestId, steps: documents.steps };
}

/** A request whose first step has failed, ready to be resumed. */
async function failed() {
  const { requestId, steps } = await running();
  const first = steps[0]!;

  await store.transitionStep({
    requestId,
    stepId: first.stepId,
    expectedFrom: 'ready',
    to: 'running',
    audit: { actor: ACTOR, action: 'step.running' },
  });
  await store.transitionStep({
    requestId,
    stepId: first.stepId,
    expectedFrom: 'running',
    to: 'failed',
    audit: { actor: ACTOR, action: 'step.failed' },
    patch: { error: { class: 'terminal', code: 'BOOM', message: 'exploded' } },
  });
  await store.transitionRequest({
    requestId,
    expectedFrom: 'running',
    to: 'failed',
    audit: { actor: ACTOR, action: 'request.failed' },
  });

  return { requestId, steps };
}

const VALID_POLICY: ApprovalPolicy = {
  create: { 'create-user': { requiresApproval: true, approverRole: 'approver', expiryHours: 24 } },
  notify: {},
  update: {},
  delete: { 'delete-user': { requiresApproval: true, approverRole: 'admin' } },
};

describe('AC-5: the admin role can edit approval policy', () => {
  it('reads the default policy before anything is stored', async () => {
    const res = await call('/api/admin/approval-policy');

    expect(res.status).toBe(200);
    expect(((await res.json()) as { policy: ApprovalPolicy }).policy).toEqual(DEFAULT_POLICY);
  });

  it('stores an edited policy and reads it back', async () => {
    const put = await call('/api/admin/approval-policy', {
      method: 'PUT',
      body: JSON.stringify(VALID_POLICY),
    });
    expect(put.status).toBe(200);

    const got = (await (await call('/api/admin/approval-policy')).json()) as {
      policy: ApprovalPolicy;
    };
    expect(got.policy).toEqual(VALID_POLICY);
  });

  it('audits the edit with the whole policy before and after', async () => {
    await call('/api/admin/approval-policy', { method: 'PUT', body: JSON.stringify(VALID_POLICY) });

    const events = await store.listAllAudit();
    const edit = events.find((e) => e.action === 'approvalPolicy.updated')!;

    expect(edit.actor).toMatchObject({ kind: 'human', email: ADMIN });
    expect(edit.before).toEqual({ policy: DEFAULT_POLICY });
    expect(edit.after).toEqual({ policy: VALID_POLICY });
  });

  it('leaves an in-flight request on the snapshot it took at creation', async () => {
    const { requestId } = await running();

    await call('/api/admin/approval-policy', { method: 'PUT', body: JSON.stringify(VALID_POLICY) });

    // The whole point of REQ-002 AC-6: an edit cannot reach work already begun.
    const persisted = await store.getRequest(requestId);
    expect(persisted!.policySnapshot).toEqual(DEFAULT_POLICY.create);
  });

  it('refuses a policy missing a phase rather than silently defaulting it', async () => {
    const res = await call('/api/admin/approval-policy', {
      method: 'PUT',
      body: JSON.stringify({ create: {}, notify: {}, update: {} }),
    });

    expect(res.status).toBe(400);
  });

  it('refuses an unknown approver role', async () => {
    const res = await call('/api/admin/approval-policy', {
      method: 'PUT',
      body: JSON.stringify({
        ...VALID_POLICY,
        create: { 'create-user': { requiresApproval: true, approverRole: 'nobody' } },
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe('AC-5: the admin role can cancel any request', () => {
  it('cancels a running request and stops everything not yet done', async () => {
    const { requestId } = await running();

    const res = await call(`/api/admin/requests/${requestId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'raised against the wrong account' }),
    });

    expect(res.status).toBe(200);
    expect((await store.getRequest(requestId))!.status).toBe('cancelled');

    // Pending steps are stopped in the same transaction. Leaving them pending
    // would let a queued task still find work on a cancelled request.
    const steps = await store.listSteps(requestId);
    expect(steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
  });

  it('cancels a request it did not create', async () => {
    const { requestId } = await running();
    // The requester was operator@company.com; the admin is someone else.
    const res = await call(`/api/admin/requests/${requestId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'not mine, cancelling anyway' }),
    });

    expect(res.status).toBe(200);
  });

  it('audits the cancellation with the actor, the reason and what was stopped', async () => {
    const { requestId } = await running();
    await call(`/api/admin/requests/${requestId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'duplicate ticket' }),
    });

    const events = await store.listAudit(requestId);
    const cancel = events.find((e) => e.action === 'request.cancelled')!;

    expect(cancel.actor).toMatchObject({ email: ADMIN });
    expect(cancel.before).toEqual({ status: 'running' });
    expect(cancel.after).toMatchObject({ status: 'cancelled', reason: 'duplicate ticket' });
  });

  it('refuses a second cancellation with 409', async () => {
    const { requestId } = await running();
    await call(`/api/admin/requests/${requestId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'first' }),
    });

    const again = await call(`/api/admin/requests/${requestId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'second' }),
    });

    expect(again.status).toBe(409);
    expect(((await again.json()) as { observed: string }).observed).toBe('cancelled');
  });

  it('refuses a cancellation with no reason', async () => {
    const { requestId } = await running();

    const res = await call(`/api/admin/requests/${requestId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: '   ' }),
    });

    expect(res.status).toBe(400);
    expect((await store.getRequest(requestId))!.status).toBe('running');
  });
});

describe('AC-5: the admin role can resume any request', () => {
  it('puts a failed request back to work at its failed step', async () => {
    const { requestId, steps } = await failed();

    const res = await call(`/api/admin/requests/${requestId}/resume`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect((await store.getRequest(requestId))!.status).toBe('running');

    const first = (await store.listSteps(requestId))[0]!;
    expect(first.status).toBe('ready');
    expect(first.error).toBeNull();
    // The attempt counter is NOT reset: a step that has failed must not look
    // untouched after a resume.
    expect(first.attempts).toBe(steps[0]!.attempts);
  });

  it('enqueues the resumed step with its unchanged idempotency key', async () => {
    const { requestId, steps } = await failed();

    const res = await call(`/api/admin/requests/${requestId}/resume`, { method: 'POST' });

    expect(((await res.json()) as { dispatch: string }).dispatch).toBe('enqueued');
    expect(dispatcher.steps).toEqual([
      { requestId, stepId: steps[0]!.stepId, idempotencyKey: steps[0]!.idempotencyKey },
    ]);
  });

  it('audits the resume with the attempt count it is resuming from', async () => {
    const { requestId } = await failed();
    await call(`/api/admin/requests/${requestId}/resume`, { method: 'POST' });

    const resume = (await store.listAudit(requestId)).find((e) => e.action === 'request.resumed')!;

    expect(resume.actor).toMatchObject({ email: ADMIN });
    expect(resume.before).toMatchObject({ status: 'failed', stepStatus: 'failed' });
    expect(resume.after).toMatchObject({ status: 'running', stepStatus: 'ready' });
  });

  it('refuses to resume a request that has not failed', async () => {
    const { requestId } = await running();

    const res = await call(`/api/admin/requests/${requestId}/resume`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { observed: string }).observed).toBe('running');
    expect(dispatcher.steps).toHaveLength(0);
  });

  it('refuses to resume a cancelled request', async () => {
    const { requestId } = await running();
    await call(`/api/admin/requests/${requestId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'done with it' }),
    });

    const res = await call(`/api/admin/requests/${requestId}/resume`, { method: 'POST' });

    expect(res.status).toBe(409);
  });
});

describe('AC-5: the admin role can read the full audit trail', () => {
  it('returns events across every request, newest first', async () => {
    const first = await running();
    const second = await (async () => {
      const documents = buildNewRequest({
        phase: 'create',
        targetUser: 'grace.hopper@company.com',
        requestedBy: 'operator@company.com',
        payload: { ...PAYLOAD, primaryEmail: 'grace.hopper@company.com' },
        plan: stepPlanFor('create', PAYLOAD),
        policy: DEFAULT_POLICY,
      });
      await store.createRequest(documents, ACTOR);
      return documents.request.requestId;
    })();

    const body = (await (await call('/api/admin/audit')).json()) as { events: WireEvent[] };
    const ids = new Set(body.events.map((e) => e.requestId));

    expect(ids.has(first.requestId)).toBe(true);
    expect(ids.has(second)).toBe(true);

    // ISO strings on the wire, not Firestore's internal encoding.
    const times = body.events.map((e) => Date.parse(e.timestamp));
    expect(times.every((t) => Number.isFinite(t))).toBe(true);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('honours the limit and hands back a cursor for the next page', async () => {
    await running();

    const body = (await (await call('/api/admin/audit?limit=1')).json()) as {
      events: WireEvent[];
      nextBefore: number | null;
    };

    expect(body.events).toHaveLength(1);
    expect(body.nextBefore).toBe(Date.parse(body.events[0]!.timestamp));
  });

  it('pages backwards without repeating an event', async () => {
    await running();

    const page1 = (await (await call('/api/admin/audit?limit=1')).json()) as {
      events: WireEvent[];
      nextBefore: number;
    };
    const page2 = (await (
      await call(`/api/admin/audit?limit=1&before=${page1.nextBefore}`)
    ).json()) as { events: WireEvent[] };

    expect(page2.events[0]!.eventId).not.toBe(page1.events[0]!.eventId);
  });

  it('includes events that belong to no request, such as a policy edit', async () => {
    await call('/api/admin/approval-policy', { method: 'PUT', body: JSON.stringify(VALID_POLICY) });

    const body = (await (await call('/api/admin/audit')).json()) as { events: WireEvent[] };
    const edit = body.events.find((e) => e.action === 'approvalPolicy.updated')!;

    expect(edit.requestId).toBeNull();
  });
});

describe('every admin route is refused to a non-admin', () => {
  it('returns 403 for an identity with no binding', async () => {
    const { requestId } = await running();
    as('nobody@company.com');

    expect((await call('/api/admin/approval-policy')).status).toBe(403);
    expect(
      (await call('/api/admin/approval-policy', {
        method: 'PUT',
        body: JSON.stringify(VALID_POLICY),
      })).status,
    ).toBe(403);
    expect(
      (await call(`/api/admin/requests/${requestId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'nope' }),
      })).status,
    ).toBe(403);
    expect((await call(`/api/admin/requests/${requestId}/resume`, { method: 'POST' })).status).toBe(403);
    expect((await call('/api/admin/audit')).status).toBe(403);
  });

  it('returns 403 for an approver, who is not an admin', async () => {
    await store.setRoleBinding({
      subject: 'ada@company.com',
      kind: 'user',
      roles: ['requester', 'approver'],
      actor: { kind: 'human', email: ADMIN },
    });
    resolver.invalidate();
    as('ada@company.com');

    expect((await call('/api/admin/audit')).status).toBe(403);
  });
});
