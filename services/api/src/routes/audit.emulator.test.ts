import { Firestore, Timestamp } from '@google-cloud/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  ANONYMOUS_ACTOR,
  COLLECTIONS,
  CredentialStore,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type AuditEvent,
  type KeyProvider,
  type OperatorRole,
} from '@lifecycle/shared';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OperatorIdentity } from '../middleware/iapAuth.js';
import { requestRoutes } from './requests.js';

/**
 * TC-REQ-010-1 through -5, -7 and -8: the audit model itself.
 *
 * Against the emulator and over real HTTP, because every claim here is about
 * what is actually PERSISTED when an operator acts, and several are about
 * atomicity, which only a real transaction can demonstrate.
 *
 * The suite deliberately drives operator actions through the routes rather than
 * calling the store directly wherever the criterion says "when an operator
 * performs": an audit event written by a store method nobody calls from a route
 * would satisfy a store-level test and leave the product unaudited.
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

const REQUESTER = 'requester@company.com';
const APPROVER = 'approver@company.com';
const TARGET = 'grace.hopper@company.com';
const PASSWORD = 'stored-one-time-password';
const ACTOR: AuditActor = { kind: 'human', email: REQUESTER };

const HALT_FIRST: ApprovalPolicy = {
  ...DEFAULT_POLICY,
  create: { 'validate-request': { requiresApproval: true, approverRole: 'approver' } },
};

const silentDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

/** Every refusal the server records, captured as the composition root wires it. */
const refusals: { path: string; sourceIp: string }[] = [];

let identity: OperatorIdentity = { email: REQUESTER, subject: 'sub-r' };
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
      loadPolicy: async () => HALT_FIRST,
      dispatcher: silentDispatcher,
      resolver: { async rolesFor() { return roles; } },
      credentials,
      // Mirrors services/api/src/index.ts. Wiring it the same way here is the
      // point: a denial hook the real service passes but the test omits would
      // let an unaudited refusal path pass this suite.
      onDenied: (event) => {
        refusals.push({ path: event.path, sourceIp: event.sourceIp });
        void store.recordDenied({
          requestId: null,
          actor: { kind: 'human', email: event.identity.email },
          action: 'authz.role_refused',
          reason: `requires role '${event.required}'`,
          path: event.path,
          sourceIp: event.sourceIp,
        });
      },
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
  for (const collection of [
    COLLECTIONS.requests,
    COLLECTIONS.audit,
    COLLECTIONS.roleBindings,
    COLLECTIONS.credentialHandoffs,
  ]) {
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
  identity = { email: REQUESTER, subject: 'sub-r' };
  roles = ['requester', 'approver', 'admin'];
  refusals.length = 0;
  await wipe();
});

/** A halted create request, submitted through the route by the requester. */
async function halted(): Promise<{ requestId: string; stepId: string }> {
  const res = await fetch(`${base}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phase: 'create',
      payload: { primaryEmail: TARGET, givenName: 'Grace', familyName: 'Hopper' },
    }),
  });
  const body = (await res.json()) as { requestId: string; firstStep: { stepId: string } };
  return { requestId: body.requestId, stepId: body.firstStep.stepId };
}

const decide = (requestId: string, stepId: string, verb: 'approve' | 'reject') =>
  fetch(`${base}/api/requests/${requestId}/steps/${stepId}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ justification: 'reviewed the request in full' }),
  });

async function allAudit(): Promise<AuditEvent[]> {
  const snap = await db.collection(COLLECTIONS.audit).get();
  return snap.docs.map((d) => d.data() as AuditEvent);
}

// ------------------------------------------------------------------- AC-1

describe('AC-1: every audit event carries the full record shape', () => {
  it('records actor, action, target user, before/after and outcome on a state change', async () => {
    const { requestId, stepId } = await halted();
    identity = { email: APPROVER, subject: 'sub-a' };
    await decide(requestId, stepId, 'approve');

    const event = (await store.listAudit(requestId)).find((e) => e.action === 'step.approved')!;

    expect(event.actor).toMatchObject({ kind: 'human', email: APPROVER });
    expect(event.targetUser).toBe(TARGET);
    expect(event.before).toMatchObject({ status: 'awaiting_approval' });
    expect(event.after).toMatchObject({ status: 'ready', requestStatus: 'running' });
    expect(event.outcome).toBe('success');
    expect(event.timestamp).toBeInstanceOf(Timestamp);
  });

  it('gives every event an id, and never reuses one', async () => {
    const { requestId, stepId } = await halted();
    identity = { email: APPROVER, subject: 'sub-a' };
    await decide(requestId, stepId, 'approve');

    const events = await allAudit();
    const ids = events.map((e) => e.eventId);

    expect(events.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fills before/after and targetUser explicitly rather than leaving them undefined', async () => {
    // Firestore drops undefined; a field that must be readable back has to be
    // written as an explicit null, or the trail becomes ambiguous between
    // "no prior state" and "we forgot to record it".
    const { requestId } = await halted();

    for (const event of await store.listAudit(requestId)) {
      expect(event).toHaveProperty('before');
      expect(event).toHaveProperty('after');
      expect(event).toHaveProperty('targetUser');
      expect(event.actor.email).toBeTruthy();
    }
  });
});

// ------------------------------------------------------------------- AC-2

describe('AC-2: the state change and its audit event are one transaction', () => {
  it('writes neither when the transaction is forced to fail', async () => {
    const { requestId, stepId } = await halted();
    const auditBefore = (await allAudit()).length;

    // A nested array is a value Firestore refuses. Attaching one to the audit
    // payload makes the COMMIT fail, after the status update has been staged in
    // the same transaction, which is the only way to observe that the two are
    // genuinely atomic rather than merely adjacent.
    await expect(
      store.transitionStep({
        requestId,
        stepId,
        expectedFrom: 'awaiting_approval',
        to: 'failed',
        audit: {
          actor: ACTOR,
          action: 'step.failed',
          after: { poison: [[1]] as unknown as string },
        },
      }),
    ).rejects.toThrow();

    // Neither landed.
    const step = (await store.listSteps(requestId)).find((s) => s.stepId === stepId)!;
    expect(step.status).toBe('awaiting_approval');
    expect((await allAudit()).length).toBe(auditBefore);
  });

  it('writes both when it commits, for an operator approval through the route', async () => {
    const { requestId, stepId } = await halted();
    identity = { email: APPROVER, subject: 'sub-a' };

    await decide(requestId, stepId, 'approve');

    const step = (await store.listSteps(requestId)).find((s) => s.stepId === stepId)!;
    expect(step.status).toBe('ready');
    expect((await store.listAudit(requestId)).some((e) => e.action === 'step.approved')).toBe(true);
  });

  it('is atomic for a role-binding change too', async () => {
    const auditBefore = (await allAudit()).length;

    await expect(
      store.setRoleBinding({
        subject: 'poison@company.com',
        kind: 'user',
        roles: ['approver'],
        actor: { ...ACTOR, onBehalfOf: [[1]] as unknown as string },
      }),
    ).rejects.toThrow();

    expect(await store.getRoleBinding('poison@company.com')).toBeNull();
    expect((await allAudit()).length).toBe(auditBefore);
  });

  it('audits a cancellation and a resume alongside their state changes', async () => {
    const { requestId } = await halted();

    await store.cancelRequest({ requestId, actor: ACTOR, reason: 'no longer needed' });

    const events = await store.listAudit(requestId);
    expect(events.some((e) => e.action === 'request.cancelled')).toBe(true);
    expect((await store.getRequest(requestId))!.status).toBe('cancelled');
  });

  it('audits a credential retrieval in the transaction that destroys it', async () => {
    const { requestId } = await halted();
    await credentials.stash({ requestId, primaryEmail: TARGET, password: PASSWORD, ttlHours: 72 });

    await fetch(`${base}/api/requests/${requestId}/credential`);

    const events = await store.listAudit(requestId);
    expect(events.some((e) => e.action === 'credential.retrieved')).toBe(true);
  });
});

// ------------------------------------------------------------------- AC-3

describe('AC-3: refusals are audited with reason, path and source IP', () => {
  it('audits a role refusal, naming what was required and where', async () => {
    roles = [];

    const res = await fetch(`${base}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'create', payload: { primaryEmail: TARGET, givenName: 'G', familyName: 'H' } }),
    });
    expect(res.status).toBe(403);

    // The hook fires synchronously with the refusal; the write it starts is
    // fire-and-forget, so settle before reading.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const event = (await allAudit()).find((e) => e.action === 'authz.role_refused')!;

    expect(event).toBeDefined();
    expect(event.outcome).toBe('denied');
    expect(event.actor.email).toBe(REQUESTER);
    expect(event.after).toMatchObject({ reason: "requires role 'requester'" });
    expect((event.after as { path: string }).path).toContain('/api/requests');
    expect((event.after as { sourceIp: string }).sourceIp).toBeTruthy();
  });

  it('audits the self-approval refusal with path and source IP', async () => {
    const { requestId, stepId } = await halted();

    // The requester approving their own request: refused by the store's guard.
    const res = await decide(requestId, stepId, 'approve');
    expect(res.status).toBe(403);

    const event = (await store.listAudit(requestId)).find((e) => e.action === 'approval.self_refused')!;

    expect(event).toBeDefined();
    expect(event.outcome).toBe('denied');
    expect(event.actor.email).toBe(REQUESTER);
    expect((event.after as { path: string }).path).toContain(requestId);
    expect((event.after as { sourceIp: string }).sourceIp).toBeTruthy();
  });

  it('records no identity for an unverified caller, only path and source', async () => {
    // The 401 shape, written the way the composition root writes it. Recording
    // a claimed identity here would let an attacker forge attribution for their
    // own failed attempts, so the actor is the anonymous principal and the
    // path and source IP are the only identifying detail the event carries.
    await store.recordDenied({
      requestId: null,
      actor: ANONYMOUS_ACTOR,
      action: 'auth.assertion_refused',
      reason: 'JWSSignatureVerificationFailed',
      path: '/api/requests',
      sourceIp: '203.0.113.9',
    });

    const event = (await allAudit()).find((e) => e.action === 'auth.assertion_refused')!;

    expect(event.actor.kind).toBe('anonymous');
    expect(event.actor.email).toBe('unauthenticated');
    expect(event.requestId).toBeNull();
    expect(event.after).toMatchObject({
      reason: 'JWSSignatureVerificationFailed',
      path: '/api/requests',
      sourceIp: '203.0.113.9',
    });
  });

  it('keeps a 401 refusal out of every per-request audit query', async () => {
    // requestId is null on purpose: a 401 is refused before any route runs and
    // belongs to no request. A sentinel id would make the per-request history
    // answer for events that were never about it.
    const { requestId } = await halted();
    await store.recordDenied({
      requestId: null,
      actor: ANONYMOUS_ACTOR,
      action: 'auth.assertion_refused',
      reason: 'missing assertion header',
      path: '/api/requests',
      sourceIp: '203.0.113.9',
    });

    const perRequest = await store.listAudit(requestId);
    expect(perRequest.some((e) => e.action === 'auth.assertion_refused')).toBe(false);
    expect((await allAudit()).some((e) => e.action === 'auth.assertion_refused')).toBe(true);
  });
});

// ------------------------------------------------------------------- AC-4

describe('AC-4: an automated action names the system AND the human behind it', () => {
  it('records the system principal with the originating requester', async () => {
    const { requestId, stepId } = await halted();
    identity = { email: APPROVER, subject: 'sub-a' };
    await decide(requestId, stepId, 'approve');

    // A worker-side claim, written as the executor writes it.
    await store.claimStep({
      requestId,
      stepId,
      attempt: 1,
      leaseSeconds: 600,
      audit: {
        actor: { kind: 'system', email: 'lifecycle-worker', onBehalfOf: REQUESTER },
        action: 'step.claim',
        targetUser: TARGET,
      },
    });

    const event = (await store.listAudit(requestId)).find((e) => e.action === 'step.claim')!;

    expect(event.actor.kind).toBe('system');
    expect(event.actor.email).toBe('lifecycle-worker');
    // Without this, a machine action is unattributable: the trail would show
    // that something happened and nothing about who set it in motion.
    expect(event.actor.onBehalfOf).toBe(REQUESTER);
  });

  it('leaves no system event without an originating human', async () => {
    const { requestId, stepId } = await halted();
    identity = { email: APPROVER, subject: 'sub-a' };
    await decide(requestId, stepId, 'approve');
    await store.claimStep({
      requestId,
      stepId,
      attempt: 1,
      leaseSeconds: 600,
      audit: {
        actor: { kind: 'system', email: 'lifecycle-worker', onBehalfOf: REQUESTER },
        action: 'step.claim',
        targetUser: TARGET,
      },
    });

    const systemEvents = (await store.listAudit(requestId)).filter((e) => e.actor.kind === 'system');

    expect(systemEvents.length).toBeGreaterThan(0);
    for (const event of systemEvents) {
      expect(event.actor.onBehalfOf).toBeTruthy();
    }
  });
});

// ------------------------------------------------------------------- AC-5

describe('AC-5: the data access layer offers no way to alter the audit trail', () => {
  const storeSource = readFileSync(
    fileURLToPath(new URL('../../../../packages/shared/src/store.ts', import.meta.url)),
    'utf8',
  );

  it('exposes no update or delete method for audit on the store', () => {
    // The public surface, asserted directly. A method named for altering audit
    // would be the thing a future caller reaches for, so the guarantee is that
    // no such handle exists to reach.
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
      ...Object.keys(store),
    ];

    expect(surface.filter((name) => /audit/i.test(name) && /(update|delete|remove|clear)/i.test(name)))
      .toEqual([]);
    // The read paths that SHOULD exist, so this is not passing on a typo.
    expect(surface).toContain('listAudit');
    expect(surface).toContain('listAllAudit');
  });

  it('issues no delete or update against the audit collection anywhere in the store', () => {
    // A repository check, because the surface test above cannot see a delete
    // buried inside a method with an innocent name.
    const code = storeSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Split into statements and keep the ones touching the audit collection.
    // Scanning forward from COLLECTIONS.audit would miss the verb entirely:
    // the write reads tx.create(db.collection(COLLECTIONS.audit)...), so the
    // verb sits BEFORE the collection it acts on.
    const auditWrites = code
      .split(';')
      .filter((statement) => statement.includes('COLLECTIONS.audit'))
      .flatMap((statement) => [...statement.matchAll(/\.(create|update|delete|set)\(/g)])
      .map((m) => m[1]);

    // Every touch of the audit collection is a create. Not one update, set or
    // delete: append only is enforced by there being no other verb in the file.
    expect(auditWrites.length).toBeGreaterThan(0);
    expect(auditWrites.filter((verb) => verb !== 'create')).toEqual([]);
  });

  it('proves the scan can fail, on a collection the store does delete from', () => {
    // A scan nobody has seen fail is not evidence. Role bindings ARE deleted,
    // by removeRoleBinding, and the same pattern finds it.
    const code = storeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).toMatch(/tx\.delete\(/);
  });
});

// ------------------------------------------------------------------- AC-7

describe('AC-7: no audit payload carries a secret', () => {
  it('drives every audit-writing path and finds no password, ciphertext or assertion', async () => {
    const { requestId, stepId } = await halted();
    await credentials.stash({ requestId, primaryEmail: TARGET, password: PASSWORD, ttlHours: 72 });
    const ciphertext = (
      await db.collection(COLLECTIONS.credentialHandoffs).doc(requestId).get()
    ).data()!.oneTimePasswordCiphertext as string;

    // Approval, credential retrieval, a role-binding change, a refusal, and a
    // cancellation: every path that writes audit, in one run.
    identity = { email: APPROVER, subject: 'sub-a' };
    await decide(requestId, stepId, 'approve');
    await fetch(`${base}/api/requests/${requestId}/credential`);
    await store.setRoleBinding({
      subject: 'alice@company.com',
      kind: 'user',
      roles: ['approver'],
      actor: ACTOR,
    });
    await store.recordDenied({
      requestId: null,
      actor: ANONYMOUS_ACTOR,
      action: 'auth.assertion_refused',
      reason: 'JWSSignatureVerificationFailed',
      path: '/api/requests',
      sourceIp: '203.0.113.9',
    });
    await store.cancelRequest({ requestId, actor: ACTOR, reason: 'done' });

    const serialised = JSON.stringify(await allAudit());

    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(ciphertext);
    // A raw assertion is three base64url segments; none may appear at all.
    expect(serialised).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });

  it('records the reason for a failed verification without the assertion that failed', async () => {
    await store.recordDenied({
      requestId: null,
      actor: ANONYMOUS_ACTOR,
      action: 'auth.assertion_refused',
      reason: 'JWTExpired',
      path: '/api/requests',
      sourceIp: '203.0.113.9',
    });

    const event = (await allAudit()).find((e) => e.action === 'auth.assertion_refused')!;

    // The reason is the error's NAME, never the token. A trail that stored the
    // assertion would hold a replayable credential for the length of its
    // validity, in the one place designed to be kept the longest.
    expect(event.after).toMatchObject({ reason: 'JWTExpired' });
    expect(JSON.stringify(event)).not.toContain('eyJ');
  });
});

// ------------------------------------------------------------------- AC-8

describe('AC-8: the per-request history is complete and ordered', () => {
  it('returns every event for the request in ascending timestamp order', async () => {
    const { requestId, stepId } = await halted();
    identity = { email: APPROVER, subject: 'sub-a' };
    await decide(requestId, stepId, 'approve');
    await store.cancelRequest({ requestId, actor: ACTOR, reason: 'changed our minds' });

    const events = await store.listAudit(requestId);

    const millis = events.map((e) => e.timestamp.toMillis());
    expect(millis).toEqual([...millis].sort((a, b) => a - b));
    expect(events.map((e) => e.action)).toEqual([
      'request.created',
      'step.awaiting_approval',
      'step.approved',
      'request.cancelled',
    ]);
  });

  it('omits nothing: the per-request query returns every event carrying that id', async () => {
    const { requestId, stepId } = await halted();
    identity = { email: APPROVER, subject: 'sub-a' };
    await decide(requestId, stepId, 'approve');

    const viaQuery = await store.listAudit(requestId);
    const viaScan = (await allAudit()).filter((e) => e.requestId === requestId);

    expect(viaQuery).toHaveLength(viaScan.length);
    expect(new Set(viaQuery.map((e) => e.eventId))).toEqual(new Set(viaScan.map((e) => e.eventId)));
  });

  it('returns the history over HTTP in the same order', async () => {
    const { requestId, stepId } = await halted();
    identity = { email: APPROVER, subject: 'sub-a' };
    await decide(requestId, stepId, 'approve');
    identity = { email: REQUESTER, subject: 'sub-r' };

    const res = await fetch(`${base}/api/requests/${requestId}`);
    const body = (await res.json()) as { audit: { action: string }[] };

    expect(body.audit.map((e) => e.action)).toEqual([
      'request.created',
      'step.awaiting_approval',
      'step.approved',
    ]);
  });

  it('scopes the history to one request, mixing in nothing from another', async () => {
    const first = await halted();
    await store.cancelRequest({ requestId: first.requestId, actor: ACTOR, reason: 'making room' });
    const second = await halted();

    const events = await store.listAudit(second.requestId);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.requestId).toBe(second.requestId);
  });
});
