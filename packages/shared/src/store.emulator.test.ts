import { Firestore } from '@google-cloud/firestore';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, type AuditActor } from './model.js';
import { DEFAULT_POLICY } from './policy.js';
import { buildNewRequest } from './requestFactory.js';
import { stepPlanFor } from './stepPlans.js';
import { ConflictingRequestError, LifecycleStore } from './store.js';

/**
 * TC-REQ-001-1, TC-REQ-001-2 and TC-REQ-001-6, against the Firestore emulator.
 *
 * These criteria are about PERSISTENCE and about a race, and neither can be
 * proven against a hand-rolled fake: a fake would confirm the fake's rollback
 * and the fake's transaction isolation, not Firestore's. Everything here runs
 * against a real Firestore implementation with real transaction semantics.
 *
 * Run with `npm run test:emulator`, which starts the emulator around the suite.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  // Fail loudly rather than silently talking to a real project.
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const ACTOR: AuditActor = { kind: 'human', email: 'operator@company.com' };

const PAYLOAD = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  groups: ['engineering@company.com', 'platform@company.com'],
};

function documents(
  overrides: { targetUser?: string; requestedBy?: string; policy?: typeof DEFAULT_POLICY } = {},
) {
  return buildNewRequest({
    phase: 'create',
    targetUser: overrides.targetUser ?? PAYLOAD.primaryEmail,
    requestedBy: overrides.requestedBy ?? 'operator@company.com',
    payload: PAYLOAD,
    plan: stepPlanFor('create', PAYLOAD),
    policy: overrides.policy ?? DEFAULT_POLICY,
  });
}

/** The emulator has no per-test isolation, so each test clears what it wrote. */
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
afterEach(wipe);

describe('AC-1: creation persists the request and one step per plan entry', () => {
  it('writes the request document and every step document', async () => {
    const { request, steps } = await store.createRequest(documents(), ACTOR);

    const persisted = await store.getRequest(request.requestId);
    const persistedSteps = await store.listSteps(request.requestId);

    expect(persisted).not.toBeNull();
    expect(persisted!.requestId).toBe(request.requestId);
    expect(persistedSteps).toHaveLength(steps.length);
  });

  it('persists every step as pending with attempt 0', async () => {
    const { request } = await store.createRequest(documents(), ACTOR);

    for (const step of await store.listSteps(request.requestId)) {
      expect(step.status).toBe('pending');
      expect(step.attempts).toBe(0);
    }
  });

  it('persists steps in execution order with their snapshotted input', async () => {
    const { request } = await store.createRequest(documents(), ACTOR);
    const persisted = await store.listSteps(request.requestId);

    expect(persisted.map((s) => s.name)).toEqual([
      'validate-request',
      'create-user',
      'apply-attributes',
      'assign-group',
      'assign-group',
      'verify-account',
    ]);
    expect(persisted.filter((s) => s.name === 'assign-group').map((s) => s.input.groupKey)).toEqual(
      PAYLOAD.groups,
    );
  });

  it('persists a distinct idempotency key on every step', async () => {
    const { request } = await store.createRequest(documents(), ACTOR);
    const keys = (await store.listSteps(request.requestId)).map((s) => s.idempotencyKey);

    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('writes the admission audit event in the same transaction', async () => {
    const { request, steps } = await store.createRequest(documents(), ACTOR);
    const audit = await store.listAudit(request.requestId);

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'request.created',
      targetUser: request.targetUser,
      actor: { email: 'operator@company.com' },
      after: { phase: 'create', status: 'draft', stepCount: steps.length },
    });
  });

  it('leaves the request in draft, so nothing has been dispatched', async () => {
    const { request } = await store.createRequest(documents(), ACTOR);

    expect((await store.getRequest(request.requestId))!.status).toBe('draft');
  });
});

describe('AC-2: a target user may have only one non-terminal request', () => {
  it('refuses a second request while the first is in flight', async () => {
    await store.createRequest(documents(), ACTOR);

    await expect(store.createRequest(documents(), ACTOR)).rejects.toBeInstanceOf(
      ConflictingRequestError,
    );
  });

  it('names the blocking request so the operator knows what to wait for', async () => {
    const first = await store.createRequest(documents(), ACTOR);

    const err = await store.createRequest(documents(), ACTOR).catch((e: Error) => e);

    expect(err).toMatchObject({
      existingRequestId: first.request.requestId,
      existingStatus: 'draft',
      targetUser: 'ada.lovelace@company.com',
    });
  });

  it('creates NO second request when it refuses', async () => {
    await store.createRequest(documents(), ACTOR);
    const blocked = documents();

    await store.createRequest(blocked, ACTOR).catch(() => undefined);

    // Neither the request nor any of its steps, nor a second audit event.
    expect(await store.getRequest(blocked.request.requestId)).toBeNull();
    expect(await store.listSteps(blocked.request.requestId)).toHaveLength(0);
    const all = await db.collection(COLLECTIONS.requests).get();
    expect(all.size).toBe(1);
  });

  it('allows a request against a DIFFERENT target user', async () => {
    await store.createRequest(documents(), ACTOR);

    await expect(
      store.createRequest(documents({ targetUser: 'grace.hopper@company.com' }), ACTOR),
    ).resolves.toBeDefined();
  });

  it('allows a new request once the previous one reached a terminal status', async () => {
    const first = await store.createRequest(documents(), ACTOR);
    await store.transitionRequest({
      requestId: first.request.requestId,
      expectedFrom: 'draft',
      to: 'cancelled',
      audit: { actor: ACTOR, action: 'request.cancelled' },
    });

    await expect(store.createRequest(documents(), ACTOR)).resolves.toBeDefined();
  });

  it('matches on the normalised target, so casing cannot bypass the guard', async () => {
    await store.createRequest(documents({ targetUser: 'ada.lovelace@company.com' }), ACTOR);

    await expect(
      store.createRequest(documents({ targetUser: 'Ada.Lovelace@COMPANY.com' }), ACTOR),
    ).rejects.toBeInstanceOf(ConflictingRequestError);
  });

  it('admits exactly one winner when two operators submit concurrently', async () => {
    // The race the guard exists to close. A pre-transaction check would let
    // both through here.
    const results = await Promise.allSettled([
      store.createRequest(documents({ requestedBy: 'a@company.com' }), ACTOR),
      store.createRequest(documents({ requestedBy: 'b@company.com' }), ACTOR),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.collection(COLLECTIONS.requests).get()).size).toBe(1);
  });
});

describe('the create is atomic', () => {
  it('writes nothing at all when the guard rejects', async () => {
    await store.createRequest(documents(), ACTOR);
    const before = (await db.collection(COLLECTIONS.audit).get()).size;

    await store.createRequest(documents(), ACTOR).catch(() => undefined);

    // A partially applied create would leave orphan steps or a second audit
    // event behind. Firestore rolls the whole transaction back.
    expect((await db.collection(COLLECTIONS.audit).get()).size).toBe(before);
  });
});

describe('AC-6: the first step is dispatched or halted per the snapshotted policy', () => {
  it('releases the first step when no approval is required', async () => {
    const { request } = await store.createRequest(documents(), ACTOR);

    const result = await store.startFirstStep(request.requestId, ACTOR);

    expect(result.outcome).toBe('dispatched');
    const [first] = await store.listSteps(request.requestId);
    expect(first!.status).toBe('ready');
    expect((await store.getRequest(request.requestId))!.status).toBe('running');
  });

  it('halts the first step when the snapshot requires approval', async () => {
    const policy = {
      ...DEFAULT_POLICY,
      create: { 'validate-request': { requiresApproval: true, approverRole: 'approver' as const } },
    };
    const { request } = await store.createRequest(documents({ policy }), ACTOR);

    const result = await store.startFirstStep(request.requestId, ACTOR);

    expect(result.outcome).toBe('awaiting_approval');
    const [first] = await store.listSteps(request.requestId);
    expect(first!.status).toBe('awaiting_approval');
    expect((await store.getRequest(request.requestId))!.status).toBe('awaiting_approval');
  });

  it('reads the snapshot, so a policy edit after creation changes nothing', async () => {
    const policy = {
      ...DEFAULT_POLICY,
      create: { 'validate-request': { requiresApproval: true, approverRole: 'approver' as const } },
    };
    const { request } = await store.createRequest(documents({ policy }), ACTOR);

    // The live policy is irrelevant by now: requiresApproval was frozen onto
    // the step document at creation.
    policy.create['validate-request']!.requiresApproval = false;

    expect((await store.startFirstStep(request.requestId, ACTOR)).outcome).toBe('awaiting_approval');
  });

  it('leaves every later step pending, so only the first is released', async () => {
    const { request } = await store.createRequest(documents(), ACTOR);
    await store.startFirstStep(request.requestId, ACTOR);

    const steps = await store.listSteps(request.requestId);
    expect(steps.slice(1).every((s) => s.status === 'pending')).toBe(true);
  });
});

describe('AC-7: a halt cannot commit without the notification being committed to', () => {
  const approvalPolicy = {
    ...DEFAULT_POLICY,
    create: { 'validate-request': { requiresApproval: true, approverRole: 'approver' as const } },
  };

  it('writes the notification record in the same transaction as the halt', async () => {
    const { request } = await store.createRequest(documents({ policy: approvalPolicy }), ACTOR);

    await store.startFirstStep(request.requestId, ACTOR);

    const [first] = await store.listSteps(request.requestId);
    expect(first!.status).toBe('awaiting_approval');
    // The outbox entry. Unsent: REQ-032 sends from it and stamps sentAt.
    expect(first!.approverNotification).not.toBeNull();
    expect(first!.approverNotification!.sentAt).toBeNull();
  });

  it('never leaves a halted step without a notification record', async () => {
    const { request } = await store.createRequest(documents({ policy: approvalPolicy }), ACTOR);
    await store.startFirstStep(request.requestId, ACTOR);

    const halted = (await store.listSteps(request.requestId)).filter(
      (s) => s.status === 'awaiting_approval',
    );

    expect(halted).toHaveLength(1);
    for (const step of halted) {
      expect(step.approverNotification).not.toBeNull();
    }
  });

  it('records the halt and its notification commitment in one audit event', async () => {
    const { request } = await store.createRequest(documents({ policy: approvalPolicy }), ACTOR);
    await store.startFirstStep(request.requestId, ACTOR);

    const audit = await store.listAudit(request.requestId);
    const halt = audit.find((e) => e.action === 'step.awaiting_approval');

    expect(halt).toBeDefined();
    expect(halt!.after).toMatchObject({ status: 'awaiting_approval', notificationScheduled: true });
  });

  it('writes no notification record when the step is dispatched instead', async () => {
    const { request } = await store.createRequest(documents(), ACTOR);
    await store.startFirstStep(request.requestId, ACTOR);

    const [first] = await store.listSteps(request.requestId);
    expect(first!.approverNotification).toBeNull();
  });
});
