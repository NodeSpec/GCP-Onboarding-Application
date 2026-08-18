import { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  LifecycleStore,
  type ApprovalPolicy,
  type EnqueueStepInput,
  type ScheduleAt,
  type TaskDispatcher,
} from '@lifecycle/shared';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RoleResolver } from '../authz.js';
import type { OperatorIdentity } from '../middleware/iapAuth.js';
import { requestRoutes } from './requests.js';
import { emulatorDb, startTestServer, type TestServer, wipeAll } from '@lifecycle/test-support';

/**
 * TC-REQ-001-2, TC-REQ-001-4 and TC-REQ-001-5, end to end over HTTP.
 *
 * The routes run on a real listening server against the Firestore emulator, so
 * the status codes, the persistence and the ordering between them are all
 * observed rather than inferred. Only the IAP assertion is substituted: identity
 * is injected directly, because verification itself is covered by the IAP suite
 * and re-proving it here would test the wrong thing.
 */

const db = emulatorDb();
const store = new LifecycleStore(db);

const VALID = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  orgUnitPath: '/Engineering',
  groups: ['engineering@company.com', 'platform@company.com'],
};

/**
 * Records what was enqueued instead of reaching Cloud Tasks. The task-name
 * derivation is proven in the shared dispatcher suite; what matters here is
 * WHICH enqueue each route makes, and that it happens only after the state has
 * committed.
 */
class RecordingDispatcher implements TaskDispatcher {
  steps: EnqueueStepInput[] = [];
  notifications: { requestId: string; stepId: string }[] = [];
  expiries: { requestId: string; stepId: string; fireAt: ScheduleAt }[] = [];
  failNext = false;

  private guard() {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('cloud tasks unavailable');
    }
  }

  async enqueueStep(input: EnqueueStepInput) {
    this.guard();
    this.steps.push(input);
  }

  async enqueueApproverNotification(input: { requestId: string; stepId: string }) {
    this.guard();
    this.notifications.push(input);
  }

  async enqueueApprovalExpiry(input: { requestId: string; stepId: string; fireAt: ScheduleAt }) {
    this.guard();
    this.expiries.push(input);
  }

  reset() {
    this.steps = [];
    this.notifications = [];
    this.expiries = [];
    this.failNext = false;
  }
}

const dispatcher = new RecordingDispatcher();

let identity: OperatorIdentity = { email: 'operator@company.com', subject: 'sub-1' };
let roles: RoleResolver = { async rolesFor() { return ['requester']; } };

let harness: TestServer;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stands in for iapAuth, which is proven separately.
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
      resolver: { rolesFor: (i) => roles.rolesFor(i) },
    }),
  );

  harness = await startTestServer(app);
  base = harness.base;
});

afterAll(() => harness.close());

const wipe = () => wipeAll(db);

beforeAll(wipe);
afterEach(async () => {
  roles = { async rolesFor() { return ['requester']; } };
  identity = { email: 'operator@company.com', subject: 'sub-1' };
  dispatcher.reset();
  await wipe();
});

const post = (body: unknown) =>
  fetch(`${base}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = (id: string) => fetch(`${base}/api/requests/${id}`);

const submit = (payload: unknown = VALID) => post({ phase: 'create', payload });

describe('POST admits a valid submission', () => {
  it('returns 201 with the request and its planned steps', async () => {
    const res = await submit();

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // Started, not left in draft: the first step is released on admission.
    expect(body.status).toBe('running');
    expect(body.firstStep).toMatchObject({ stepId: '000-validate-request', status: 'ready' });
    expect(body.targetUser).toBe(VALID.primaryEmail);
    expect(body.steps).toHaveLength(6);
  });

  it('enqueues the first step with the key that was persisted on it', async () => {
    const body = (await (await submit()).json()) as { requestId: string; dispatch: string };

    expect(body.dispatch).toBe('enqueued');
    expect(dispatcher.steps).toHaveLength(1);

    // The enqueued key must be the one on the persisted step. If the route
    // recomputed it instead, a divergence would give the task a different name
    // and the deduplication would stop collapsing repeats.
    const step = (await store.listSteps(body.requestId))[0]!;
    expect(dispatcher.steps[0]).toMatchObject({
      requestId: body.requestId,
      stepId: step.stepId,
      idempotencyKey: step.idempotencyKey,
    });
    expect(dispatcher.notifications).toHaveLength(0);
  });

  it('admits the request even when the enqueue fails, and says so', async () => {
    dispatcher.failNext = true;

    const res = await submit();
    const body = (await res.json()) as { requestId: string; dispatch: string };

    // The state is committed and correct; only the follow-up task is missing.
    // Reporting 500 would send the operator into a retry that returns 409
    // against their own request.
    expect(res.status).toBe(201);
    expect(body.dispatch).toBe('deferred');

    const persisted = await store.getRequest(body.requestId);
    expect(persisted!.status).toBe('running');
    expect((await store.listSteps(body.requestId))[0]!.status).toBe('ready');
  });

  it('records the verified caller as the requester, not a client-supplied field', async () => {
    identity = { email: 'Someone.Else@Company.com', subject: 'sub-2' };

    const body = (await (await submit()).json()) as { requestId: string };
    const persisted = await store.getRequest(body.requestId);

    expect(persisted!.requestedBy).toBe('someone.else@company.com');
  });
});

describe('AC-4: validation happens before anything is persisted', () => {
  it('rejects a malformed payload with 400', async () => {
    const res = await submit({ ...VALID, primaryEmail: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  it('persists NOTHING when the payload is rejected', async () => {
    await submit({ ...VALID, primaryEmail: 'not-an-email' });
    await submit({ givenName: 'A' });
    await submit({ ...VALID, unknownField: 1 });

    // The point of the criterion: a rejected submission leaves no request for
    // an operator to wonder about.
    expect((await db.collection(COLLECTIONS.requests).get()).size).toBe(0);
    expect((await db.collection(COLLECTIONS.audit).get()).size).toBe(0);
  });

  it('rejects an unimplemented phase with 400 and persists nothing', async () => {
    const res = await post({ phase: 'delete', payload: VALID });

    expect(res.status).toBe(400);
    expect((await db.collection(COLLECTIONS.requests).get()).size).toBe(0);
  });

  it('rejects a malformed envelope with 400', async () => {
    expect((await post({ payload: VALID })).status).toBe(400);
    expect((await post({ phase: 'create' })).status).toBe(400);
    expect((await post({ phase: 'nonsense', payload: VALID })).status).toBe(400);
  });

  it('names the offending fields so the operator can fix the submission', async () => {
    const res = await submit({ ...VALID, primaryEmail: 'bad', givenName: '' });
    const body = (await res.json()) as { issues: { path: string }[] };

    expect(body.issues.map((i) => i.path).sort()).toEqual(['givenName', 'primaryEmail']);
  });
});

describe('AC-2: a second in-flight request for the same target is refused with 409', () => {
  it('returns 409 and names the blocking request', async () => {
    const first = (await (await submit()).json()) as { requestId: string };

    const res = await submit();
    expect(res.status).toBe(409);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.existingRequestId).toBe(first.requestId);
    // 'running', not 'draft': admission starts the first step, so the blocking
    // request has already moved on by the time the second is refused.
    expect(body.existingStatus).toBe('running');
  });

  it('creates no second request', async () => {
    await submit();
    await submit();

    expect((await db.collection(COLLECTIONS.requests).get()).size).toBe(1);
  });

  it('admits a request for a different target user', async () => {
    await submit();

    const res = await submit({ ...VALID, primaryEmail: 'grace.hopper@company.com' });
    expect(res.status).toBe(201);
  });
});

describe('AC-5: the full step history is retrievable in one call', () => {
  it('returns the request, its steps in order, and the audit trail', async () => {
    const created = (await (await submit()).json()) as { requestId: string };

    const res = await get(created.requestId);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      request: { requestId: string };
      steps: { name: string; status: string; attempts: number }[];
      audit: { action: string }[];
    };

    expect(body.request.requestId).toBe(created.requestId);
    expect(body.steps.map((s) => s.name)).toEqual([
      'validate-request',
      'create-user',
      'apply-attributes',
      'assign-group',
      'assign-group',
      'verify-account',
    ]);
    // First released, the rest still pending.
    expect(body.steps[0]!.status).toBe('ready');
    expect(body.steps.slice(1).every((s) => s.status === 'pending' && s.attempts === 0)).toBe(true);
    expect(body.audit.map((e) => e.action)).toEqual(['request.created', 'step.dispatched']);
  });

  it('returns 404 for a request that does not exist', async () => {
    expect((await get('no-such-request')).status).toBe(404);
  });
});

describe('REQ-012 AC-1: every route checks its role before the handler runs', () => {
  it('refuses a submission from an identity without the requester role with 403', async () => {
    roles = { async rolesFor() { return []; } };

    const res = await submit();

    expect(res.status).toBe(403);
    expect((await db.collection(COLLECTIONS.requests).get()).size).toBe(0);
  });

  it('refuses a read from an identity without the requester role', async () => {
    const created = (await (await submit()).json()) as { requestId: string };
    roles = { async rolesFor() { return []; } };

    expect((await get(created.requestId)).status).toBe(403);
  });
});

/**
 * REQ-002 AC-1 to AC-5: two-party approval over HTTP.
 *
 * The approval policy used here halts the FIRST step, so a submission lands in
 * 'awaiting_approval' with nothing dispatched and the approve/reject routes
 * have something real to act on.
 */
describe('REQ-002: approve and reject', () => {
  const HALT_FIRST = {
    ...DEFAULT_POLICY,
    create: { 'validate-request': { requiresApproval: true, approverRole: 'approver' as const } },
  };

  let approvalBase: string;
  let approvalHarness: TestServer;
  let approvalIdentity: OperatorIdentity;
  let approvalRoles: RoleResolver;
  let livePolicy: ApprovalPolicy = HALT_FIRST;

  beforeAll(async () => {
    approvalIdentity = { email: 'requester@company.com', subject: 'sub-r' };
    approvalRoles = { async rolesFor() { return ['requester', 'approver']; } };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.identity = approvalIdentity;
      next();
    });
    app.use(
      '/api/requests',
      requestRoutes({
        store,
        loadPolicy: async () => livePolicy,
        dispatcher,
        resolver: { rolesFor: (i) => approvalRoles.rolesFor(i) },
      }),
    );
    approvalHarness = await startTestServer(app);
    approvalBase = approvalHarness.base;
  });

  afterAll(() => approvalHarness.close());

  afterEach(() => {
    approvalIdentity = { email: 'requester@company.com', subject: 'sub-r' };
    approvalRoles = { async rolesFor() { return ['requester', 'approver']; } };
    livePolicy = HALT_FIRST;
  });

  async function halted() {
    approvalIdentity = { email: 'requester@company.com', subject: 'sub-r' };
    const res = await fetch(`${approvalBase}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'create', payload: VALID }),
    });
    return (await res.json()) as { requestId: string; firstStep: { stepId: string } };
  }

  const decide = (id: string, stepId: string, verb: 'approve' | 'reject', body: unknown) =>
    fetch(`${approvalBase}/api/requests/${id}/steps/${stepId}/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('AC-1: a step requiring approval halts and dispatches nothing', async () => {
    const created = await halted();

    const persisted = await store.getRequest(created.requestId);
    const steps = await store.listSteps(created.requestId);

    expect(persisted!.status).toBe('awaiting_approval');
    expect(steps[0]!.status).toBe('awaiting_approval');
    expect(steps.slice(1).every((s) => s.status === 'pending')).toBe(true);

    // The approver is notified, and no execution task exists: the halt has to
    // stop the work, not merely annotate it.
    expect(dispatcher.notifications).toEqual([
      { requestId: created.requestId, stepId: created.firstStep.stepId },
    ]);
    expect(dispatcher.steps).toHaveLength(0);
  });

  it('AC-7: a first-step halt with an expiry configured schedules the firing', async () => {
    // The FIRST step's halt never passes through the worker's advance(), so the
    // API route carries its own scheduling. Without this, a policy gating step
    // one with an expiry would wait forever while every later step expired
    // correctly, and nothing would ever say why.
    livePolicy = {
      ...HALT_FIRST,
      create: {
        'validate-request': { requiresApproval: true, approverRole: 'approver', expiryHours: 6 },
      },
    };
    const before = Date.now();

    const created = await halted();

    expect(dispatcher.expiries).toHaveLength(1);
    expect(dispatcher.expiries[0]).toMatchObject({
      requestId: created.requestId,
      stepId: created.firstStep.stepId,
    });

    const fireAt = dispatcher.expiries[0]!.fireAt;
    const millis = fireAt instanceof Date ? fireAt.getTime() : fireAt.toMillis();
    expect(millis).toBeGreaterThanOrEqual(before + 6 * 3_600_000);
    expect(millis).toBeLessThanOrEqual(Date.now() + 6 * 3_600_000);
  });

  it('AC-7: a halt without an expiry configured schedules no firing', async () => {
    await halted();

    expect(dispatcher.expiries).toEqual([]);
  });

  it('AC-2: the requester cannot approve their own request', async () => {
    const created = await halted();
    // Same identity that submitted.
    const res = await decide(created.requestId, created.firstStep.stepId, 'approve', {
      justification: 'looks fine to me',
    });

    expect(res.status).toBe(403);
    const steps = await store.listSteps(created.requestId);
    expect(steps[0]!.status).toBe('awaiting_approval');
  });

  it('AC-3: a distinct approver releases the step and resumes the request', async () => {
    const created = await halted();
    approvalIdentity = { email: 'approver@company.com', subject: 'sub-a' };

    const res = await decide(created.requestId, created.firstStep.stepId, 'approve', {
      justification: 'checked the ticket',
    });

    expect(res.status).toBe(200);
    expect((await store.listSteps(created.requestId))[0]!.status).toBe('ready');
    expect((await store.getRequest(created.requestId))!.status).toBe('running');

    // Approval releases the step, so the execution task is enqueued here rather
    // than at submission (REQ-002 AC-3).
    const step = (await store.listSteps(created.requestId))[0]!;
    expect(dispatcher.steps).toEqual([
      {
        requestId: created.requestId,
        stepId: created.firstStep.stepId,
        idempotencyKey: step.idempotencyKey,
      },
    ]);
  });

  it('AC-4: a rejection terminates the request and records the decision', async () => {
    const created = await halted();
    approvalIdentity = { email: 'approver@company.com', subject: 'sub-a' };

    const res = await decide(created.requestId, created.firstStep.stepId, 'reject', {
      justification: 'wrong org unit',
    });

    expect(res.status).toBe(200);
    expect((await store.getRequest(created.requestId))!.status).toBe('rejected');

    const step = (await store.listSteps(created.requestId))[0]!;
    expect(step.status).toBe('failed');
    expect(step.approval).toMatchObject({
      approvedBy: 'approver@company.com',
      decision: 'rejected',
      justification: 'wrong org unit',
    });
    expect(step.approval!.at).toBeTruthy();
  });

  it('AC-4: no further step is dispatched after a rejection', async () => {
    const created = await halted();
    approvalIdentity = { email: 'approver@company.com', subject: 'sub-a' };
    await decide(created.requestId, created.firstStep.stepId, 'reject', { justification: 'no' });

    const steps = await store.listSteps(created.requestId);
    expect(steps.slice(1).every((s) => s.status === 'pending')).toBe(true);
    // Nothing enqueued at all: a rejection has no work to release.
    expect(dispatcher.steps).toHaveLength(0);
  });

  it.each([
    ['an empty justification', { justification: '' }],
    ['a whitespace-only justification', { justification: '   \t  ' }],
    ['a missing justification', {}],
  ])('AC-5: refuses %s with 400', async (_label, body) => {
    const created = await halted();
    approvalIdentity = { email: 'approver@company.com', subject: 'sub-a' };

    const res = await decide(created.requestId, created.firstStep.stepId, 'approve', body);

    expect(res.status).toBe(400);
    expect((await store.listSteps(created.requestId))[0]!.status).toBe('awaiting_approval');
  });

  it('refuses a second decision on an already-decided step with 409', async () => {
    const created = await halted();
    approvalIdentity = { email: 'approver@company.com', subject: 'sub-a' };
    await decide(created.requestId, created.firstStep.stepId, 'approve', { justification: 'ok' });

    const again = await decide(created.requestId, created.firstStep.stepId, 'approve', {
      justification: 'ok again',
    });

    expect(again.status).toBe(409);
  });

  it('refuses an identity without the approver role with 403', async () => {
    const created = await halted();
    approvalIdentity = { email: 'approver@company.com', subject: 'sub-a' };
    approvalRoles = { async rolesFor() { return ['requester']; } };

    const res = await decide(created.requestId, created.firstStep.stepId, 'approve', {
      justification: 'ok',
    });

    expect(res.status).toBe(403);
    expect((await store.listSteps(created.requestId))[0]!.status).toBe('awaiting_approval');
  });
});
