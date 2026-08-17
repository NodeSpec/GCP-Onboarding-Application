import { Firestore, Timestamp } from '@google-cloud/firestore';
import { randomBytes } from 'node:crypto';
import {
  COLLECTIONS,
  CredentialStore,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type AuditActor,
  type AuditEvent,
  type KeyProvider,
} from '@lifecycle/shared';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OperatorIdentity } from '../middleware/iapAuth.js';
import { requestRoutes } from './requests.js';

/**
 * TC-REQ-017-1 through TC-REQ-017-6, and TC-REQ-030-5.
 *
 * Over real HTTP against the Firestore emulator, because the criterion is
 * specifically about a status code: a superseded credential must answer 410.
 * Asserting that the store returns null would prove the store works and say
 * nothing about what an operator's console actually receives.
 *
 * The worker is NOT imported here. The states this route has to answer for are
 * staged directly through the shared store, which is exactly what the worker
 * writes; reaching across into the worker package to produce them would have
 * made the API service depend on it. The worker's own suite proves it writes
 * these states, this suite proves the route reads them correctly.
 *
 * Only the IAP assertion is substituted. The encryption is real.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

/** A fixed key, so a failure is never a flaky key generation. */
const KEY = randomBytes(32);
const keys: KeyProvider = {
  resolve: async () => ({ key: KEY, version: 'versions/1' }),
  resolveVersion: async () => ({ key: KEY, version: 'versions/1' }),
};
const credentials = new CredentialStore(db, keys);

const OPERATOR = 'operator@company.com';
const ACTOR: AuditActor = { kind: 'human', email: OPERATOR };
const TARGET = 'ada.lovelace@company.com';
const PASSWORD = 'original-one-time-password';

const silentDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

let identity: OperatorIdentity = { email: OPERATOR, subject: 'sub-1' };
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stands in for iapAuth, which is proven in its own suite.
  app.use((req, _res, next) => {
    req.identity = identity;
    next();
  });
  app.use(
    '/api/requests',
    requestRoutes({
      store,
      loadPolicy: async () => DEFAULT_POLICY,
      dispatcher: silentDispatcher,
      resolver: { async rolesFor() { return ['requester']; } },
      credentials,
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
  identity = { email: OPERATOR, subject: 'sub-1' };
  await wipe();
});

/** A create request with a stashed credential, as Phase 1 leaves things. */
async function createRequestWithCredential(requestId: string, requestedBy = OPERATOR) {
  const payload = { primaryEmail: TARGET, givenName: 'Ada', familyName: 'Lovelace' };
  const documents = buildNewRequest({
    phase: 'create',
    targetUser: TARGET,
    requestedBy,
    payload,
    plan: stepPlanFor('create', payload),
    policy: DEFAULT_POLICY,
    newId: () => requestId,
  });
  await store.createRequest(documents, { kind: 'human', email: requestedBy });
  await credentials.stash({ requestId, primaryEmail: TARGET, password: PASSWORD, ttlHours: 72 });
  await store.cancelRequest({ requestId, actor: ACTOR, reason: 'fixture' });
  return documents;
}

/** A notify request whose credential step reused an existing record. */
async function resendReusing(credentialRequestId: string, requestId = 'resend-request') {
  const payload = {
    primaryEmail: TARGET,
    givenName: 'Ada',
    familyName: 'Lovelace',
    notificationEmail: 'ada.personal@example.com',
    regenerate: false,
  };
  const documents = buildNewRequest({
    phase: 'notify',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload,
    plan: stepPlanFor('notify', payload),
    policy: DEFAULT_POLICY,
    newId: () => requestId,
  });
  await store.createRequest(documents, ACTOR);

  const step = documents.steps.find((s) => s.name === 'confirm-credential')!;
  const record = (await db.collection(COLLECTIONS.credentialHandoffs).doc(credentialRequestId).get()).data()!;
  await store.recordCredential({
    requestId,
    stepId: step.stepId,
    targetUser: TARGET,
    record: {
      credentialRequestId,
      rotatedAt: null,
      supersededRequestId: null,
      keyVersion: record.keyVersion as string,
      expiresAt: record.expiresAt as Timestamp,
    },
    actor: { kind: 'system', email: 'lifecycle-worker', onBehalfOf: OPERATOR },
    action: 'credential.confirmed',
  });
  return requestId;
}

/** A notify request that rotated the credential, superseding an earlier one. */
async function resendRotating(supersedes: string, requestId = 'rotate-request') {
  const payload = {
    primaryEmail: TARGET,
    givenName: 'Ada',
    familyName: 'Lovelace',
    notificationEmail: 'ada.personal@example.com',
    regenerate: true,
  };
  const documents = buildNewRequest({
    phase: 'notify',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload,
    plan: stepPlanFor('notify', payload),
    policy: DEFAULT_POLICY,
    newId: () => requestId,
  });
  await store.createRequest(documents, ACTOR);

  const step = documents.steps.find((s) => s.name === 'regenerate-credential')!;
  const handoff = await credentials.seal({
    primaryEmail: TARGET,
    password: 'regenerated-one-time-password',
    ttlHours: 72,
  });
  await store.recordCredential({
    requestId,
    stepId: step.stepId,
    targetUser: TARGET,
    record: {
      credentialRequestId: requestId,
      rotatedAt: Timestamp.now(),
      supersededRequestId: supersedes,
      keyVersion: handoff.keyVersion,
      expiresAt: handoff.expiresAt,
    },
    rotation: { handoff, supersedes },
    actor: { kind: 'system', email: 'lifecycle-worker', onBehalfOf: OPERATOR },
    action: 'credential.rotated',
  });
  return requestId;
}

const get = (requestId: string) => fetch(`${base}/api/requests/${requestId}/credential`);

describe('the one-time password is handed over once', () => {
  it('returns the password to the operator who created the request', async () => {
    await createRequestWithCredential('create-1');

    const res = await get('create-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ primaryEmail: TARGET, oneTimePassword: PASSWORD });
  });

  it('answers 410 on the second attempt', async () => {
    await createRequestWithCredential('create-1');

    expect((await get('create-1')).status).toBe(200);
    expect((await get('create-1')).status).toBe(410);
  });

  it('answers 410 once the TTL has passed', async () => {
    await createRequestWithCredential('create-1');
    await db
      .collection(COLLECTIONS.credentialHandoffs)
      .doc('create-1')
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });

    expect((await get('create-1')).status).toBe(410);
  });

  it('destroys the ciphertext of an expired record rather than leaving it readable', async () => {
    // The TTL exists to end an exposure. A record that answers 410 while still
    // holding decryptable ciphertext has not ended it, it has only stopped
    // admitting to it (AC-4).
    await createRequestWithCredential('create-1');
    await db
      .collection(COLLECTIONS.credentialHandoffs)
      .doc('create-1')
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });

    await get('create-1');

    const record = (await db.collection(COLLECTIONS.credentialHandoffs).doc('create-1').get()).data()!;
    expect(record.oneTimePasswordCiphertext).toBe('');
  });

  it('answers 410 when no credential was ever stored', async () => {
    // Same status as every other empty case. Distinguishing them would let a
    // caller learn the account's history from status codes alone.
    const documents = buildNewRequest({
      phase: 'create',
      targetUser: TARGET,
      requestedBy: OPERATOR,
      payload: { primaryEmail: TARGET, givenName: 'Ada', familyName: 'Lovelace' },
      plan: stepPlanFor('create', { primaryEmail: TARGET }),
      policy: DEFAULT_POLICY,
      newId: () => 'no-credential',
    });
    await store.createRequest(documents, ACTOR);

    expect((await get('no-credential')).status).toBe(410);
  });

  it('answers 404 for a request that does not exist', async () => {
    expect((await get('never-existed')).status).toBe(404);
  });

  it('refuses an operator who did not create the request', async () => {
    await createRequestWithCredential('create-1');
    identity = { email: 'someone.else@company.com', subject: 'sub-2' };

    const res = await get('create-1');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_the_requester' });
  });

  it('leaves the credential intact when it refuses the wrong operator', async () => {
    // Refused BEFORE the claim. A refusal that had already destroyed the
    // ciphertext would let anyone who can reach the route deny the credential
    // to the person entitled to it.
    await createRequestWithCredential('create-1');
    identity = { email: 'someone.else@company.com', subject: 'sub-2' };
    await get('create-1');
    identity = { email: OPERATOR, subject: 'sub-1' };

    expect((await get('create-1')).status).toBe(200);
  });

  it('puts the password in the body and nowhere else', async () => {
    await createRequestWithCredential('create-1');

    const res = await get('create-1');

    // Not in a redirect target, and not echoed into any header.
    expect(res.redirected).toBe(false);
    expect(JSON.stringify([...res.headers])).not.toContain(PASSWORD);
    expect(await res.text()).toContain(PASSWORD);
  });
});

describe('REQ-030 AC-5: a superseded credential is unretrievable', () => {
  it('answers 410 for the request whose credential was replaced', async () => {
    await createRequestWithCredential('create-1');
    await resendRotating('create-1');

    const res = await get('create-1');

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'credential_unavailable' });
  });

  it('answers 200 with the NEW password for the request that replaced it', async () => {
    // The positive control. A 410 caused by a broken route rather than by the
    // supersession would satisfy the assertion above on its own.
    await createRequestWithCredential('create-1');
    const rotateId = await resendRotating('create-1');

    const res = await get(rotateId);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ oneTimePassword: 'regenerated-one-time-password' });
  });

  it('never returns the superseded password, even before the new one is claimed', async () => {
    await createRequestWithCredential('create-1');
    await resendRotating('create-1');

    expect(await (await get('create-1')).text()).not.toContain(PASSWORD);
  });
});

describe('REQ-030 AC-3: a resend that reused a credential retrieves it', () => {
  it('follows the pointer to the record the original request produced', async () => {
    // Without the pointer the handoff document would still be keyed by the
    // create request, and retrieval against the resend would be a 410 for a
    // credential that exists and is perfectly valid.
    await createRequestWithCredential('create-1');
    const resendId = await resendReusing('create-1');

    const res = await get(resendId);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ oneTimePassword: PASSWORD });
  });

  it('consumes the shared record, so the original request cannot hand it over again', async () => {
    // One credential, retrievable once, whichever request is asked. Two
    // requests pointing at one record must not mean two retrievals of it.
    await createRequestWithCredential('create-1');
    const resendId = await resendReusing('create-1');

    expect((await get(resendId)).status).toBe(200);
    expect((await get('create-1')).status).toBe(410);
  });

  it('refuses an operator who created neither request', async () => {
    await createRequestWithCredential('create-1');
    const resendId = await resendReusing('create-1');
    identity = { email: 'someone.else@company.com', subject: 'sub-2' };

    expect((await get(resendId)).status).toBe(403);
  });
});

async function auditFor(requestId: string): Promise<AuditEvent[]> {
  return store.listAudit(requestId);
}

describe('AC-3: two concurrent retrievals yield exactly one success', () => {
  it('gives the password to one caller and 410 to the other', async () => {
    // The claim reads and clears the ciphertext in a single Firestore
    // transaction, and this is the only way to show that actually holds. A test
    // that retrieved twice in sequence would pass against a broken read-then-
    // write implementation, because nothing would be racing it.
    await createRequestWithCredential('create-1');

    const [a, b] = await Promise.all([get('create-1'), get('create-1')]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([200, 410]);
  });

  it('returns the password exactly once across ten concurrent callers', async () => {
    // Ten rather than two, because a race that resolves correctly half the time
    // passes a two-way test often enough to look green.
    await createRequestWithCredential('create-1');

    const responses = await Promise.all(Array.from({ length: 10 }, () => get('create-1')));
    const bodies = await Promise.all(responses.map((r) => r.text()));

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(bodies.filter((b) => b.includes(PASSWORD))).toHaveLength(1);
  });

  it('leaves the record destroyed, not merely marked, after the race', async () => {
    await createRequestWithCredential('create-1');

    await Promise.all(Array.from({ length: 5 }, () => get('create-1')));

    const record = (await db.collection(COLLECTIONS.credentialHandoffs).doc('create-1').get()).data()!;
    expect(record.oneTimePasswordCiphertext).toBe('');
    expect(record.retrievedAt).not.toBeNull();
  });
});

describe('AC-6: every retrieval attempt is audited, naming the operator', () => {
  it('records a success naming the operator who took it', async () => {
    await createRequestWithCredential('create-1');

    await get('create-1');
    const events = (await auditFor('create-1')).filter((e) => e.action === 'credential.retrieved');

    expect(events).toHaveLength(1);
    expect(events[0]!.actor.email).toBe(OPERATOR);
    expect(events[0]!.targetUser).toBe(TARGET);
  });

  it('records the refusal when the wrong operator asks', async () => {
    // The event an investigation actually needs, and the one an implementation
    // is most likely to forget, because nothing changed.
    await createRequestWithCredential('create-1');
    identity = { email: 'someone.else@company.com', subject: 'sub-2' };

    await get('create-1');
    const events = (await auditFor('create-1')).filter((e) => e.action === 'credential.retrieval');

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('denied');
    expect(events[0]!.actor.email).toBe('someone.else@company.com');
  });

  it('records the second attempt, not just the first', async () => {
    await createRequestWithCredential('create-1');

    await get('create-1');
    await get('create-1');
    const actions = (await auditFor('create-1')).map((e) => e.action);

    expect(actions).toContain('credential.retrieved');
    expect(actions).toContain('credential.retrieval');
  });

  it('records an attempt against an expired credential', async () => {
    await createRequestWithCredential('create-1');
    await db
      .collection(COLLECTIONS.credentialHandoffs)
      .doc('create-1')
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });

    await get('create-1');
    const events = (await auditFor('create-1')).filter((e) => e.action === 'credential.retrieval');

    expect(events).toHaveLength(1);
    expect(events[0]!.actor.email).toBe(OPERATOR);
  });

  it('audits the success inside the same transaction that destroys the ciphertext', async () => {
    // Not a nicety of ordering. An audit written after the claim would be lost
    // by a crash that had already destroyed the ciphertext, leaving a credential
    // gone with nobody recorded as holding it. Ten racing callers produce ten
    // attempts and exactly one destruction, so exactly one success event.
    await createRequestWithCredential('create-1');

    await Promise.all(Array.from({ length: 10 }, () => get('create-1')));
    const events = await auditFor('create-1');

    expect(events.filter((e) => e.action === 'credential.retrieved')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'credential.retrieval')).toHaveLength(9);
  });

  it('puts no password in any audit event', async () => {
    await createRequestWithCredential('create-1');

    await get('create-1');

    // The trail outlives the TTL that was meant to retire the credential, and
    // is readable by everyone entitled to read audit.
    expect(JSON.stringify(await auditFor('create-1'))).not.toContain(PASSWORD);
  });
});

describe('AC-5: the plaintext leaves by exactly one door', () => {
  it('logs nothing from the retrieval route', () => {
    // Structural, and it has to be: a logger call that interpolated the claimed
    // credential would put it in Cloud Logging with that sink's retention, long
    // outliving the TTL. Scanning is the only way to assert an absence.
    const source = readFileSync(fileURLToPath(new URL('./requests.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const route = source.slice(source.indexOf("'/:requestId/credential'"));
    const body = route.slice(0, route.indexOf('\n  }\n'));

    expect(body).not.toMatch(/logger\./);
    expect(body).toContain('oneTimePassword: claimed.password');
  });

  it('proves the scan can fail, on a route that does log', () => {
    // A scan nobody has seen fail is not evidence. The submission handler is
    // not the positive control here; tryEnqueue is, and it must match.
    const source = readFileSync(fileURLToPath(new URL('./requests.ts', import.meta.url)), 'utf8');

    expect(source).toMatch(/logger\.error/);
  });
});
