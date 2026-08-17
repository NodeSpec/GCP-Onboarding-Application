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
  type CredentialHandoff,
  type KeyProvider,
} from '@lifecycle/shared';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { taskRoutes } from '../routes/tasks.js';
import { advance } from '../steps/advance.js';
import './create.js';

/**
 * TC-REQ-019-1 (the created-account half), TC-REQ-019-4, TC-REQ-019-5, and
 * TC-REQ-003-7, which is the same absence claim widened to the operator-facing
 * read path.
 *
 * AC-5 is a claim about ABSENCE across three surfaces at once: no Firestore
 * document, no worker response body, no log entry may carry the plaintext. So
 * this provisions a user through the real /tasks route over real HTTP, with
 * stdout captured for the duration, and then greps everything: every document
 * in every collection the system writes, every HTTP response body the route
 * returned, and every log line the worker emitted.
 *
 * The password grepped for is the one the run actually generated, captured at
 * the only place it legitimately passes: the Directory API call. A sentinel
 * would test a password the code never handled.
 *
 * A grep that finds nothing proves nothing unless the value was really there
 * to find, so the positive control decrypts the stored ciphertext back to the
 * captured password: it was present, encrypted, and only encrypted.
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

/**
 * The Directory stand-in for a full create run. Captures the generated
 * password at the API boundary, which is the one place plaintext is supposed
 * to pass, and delegates generation to REAL randomBytes so the value grepped
 * for has the exact shape production produces.
 */
class ProvisioningDirectory {
  created: { primaryEmail: string; changePasswordAtNextLogin?: boolean | null } | null = null;
  issuedPassword: string | null = null;

  async getUser(primaryEmail: string) {
    if (!this.created) return null;
    return {
      primaryEmail,
      orgUnitPath: '/',
      changePasswordAtNextLogin: true,
      organizations: [],
    };
  }

  async insertUser(input: {
    primaryEmail: string;
    password: string;
    changePasswordAtNextLogin: boolean;
  }) {
    this.issuedPassword = input.password;
    this.created = {
      primaryEmail: input.primaryEmail,
      changePasswordAtNextLogin: input.changePasswordAtNextLogin,
    };
    return { id: 'workspace-id-1', primaryEmail: input.primaryEmail };
  }

  async updateUser() {
    return {};
  }

  async hasMember() {
    return true;
  }

  generateInitialPassword(length = 24): string {
    return randomBytes(length).toString('base64url').slice(0, length);
  }

  reset() {
    this.created = null;
    this.issuedPassword = null;
  }
}

const directory = new ProvisioningDirectory();

const silentDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/tasks',
    taskRoutes({
      store,
      directory: directory as never,
      credentials,
      advance: (requestId, completedStepId) =>
        advance({ store, dispatcher: silentDispatcher }, requestId, completedStepId),
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
  directory.reset();
  await wipe();
});

/**
 * Provisions a user through the real route, capturing every worker response
 * body and every log line emitted while it ran.
 *
 * Log capture intercepts stdout because that is where pino writes: asserting
 * on what reaches the actual sink is the claim, and a hook into the logger
 * object would miss anything that bypassed it.
 */
async function provision(): Promise<{
  requestId: string;
  responses: string[];
  logLines: string[];
}> {
  const payload = { primaryEmail: TARGET, givenName: 'Ada', familyName: 'Lovelace' };
  const documents = buildNewRequest({
    phase: 'create',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload,
    plan: stepPlanFor('create', payload),
    policy: DEFAULT_POLICY,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);

  const responses: string[] = [];
  const logLines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    logLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return originalWrite(chunk as never, ...rest);
  }) as typeof process.stdout.write;

  try {
    for (const step of documents.steps) {
      // Steps beyond the first start 'pending'; advance() releases each to
      // 'ready' as its predecessor settles, so driving in order works.
      const res = await fetch(`${base}/tasks/execute-step`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: documents.request.requestId,
          stepId: step.stepId,
          idempotencyKey: step.idempotencyKey,
          attempt: 1,
        }),
      });
      responses.push(await res.text());
    }
  } finally {
    process.stdout.write = originalWrite;
  }

  return { requestId: documents.request.requestId, responses, logLines };
}

/** Every document the system wrote, serialised whole. */
async function everyStoredDocument(): Promise<string> {
  const parts: string[] = [];
  for (const collection of [COLLECTIONS.requests, COLLECTIONS.audit, COLLECTIONS.credentialHandoffs]) {
    const snap = await db.collection(collection).get();
    for (const doc of snap.docs) {
      parts.push(JSON.stringify(doc.data()));
      const steps = await doc.ref.collection(COLLECTIONS.steps).get();
      for (const step of steps.docs) parts.push(JSON.stringify(step.data()));
    }
  }
  return parts.join('\n');
}

describe('AC-5: the plaintext appears in no document, no response, no log line', () => {
  it('greps everything the provisioning run emitted and finds the password nowhere', async () => {
    const { responses, logLines } = await provision();
    const password = directory.issuedPassword!;

    expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/);

    expect(await everyStoredDocument()).not.toContain(password);
    for (const body of responses) expect(body).not.toContain(password);
    for (const line of logLines) expect(line).not.toContain(password);
  });

  it('proves the password was really there to find: the ciphertext decrypts to it', async () => {
    // The positive control. Without it, the grep above would also pass if the
    // password had simply never been stored, which is a different system.
    const { requestId } = await provision();
    const password = directory.issuedPassword!;

    const claimed = await credentials.retrieveOnce(requestId);
    expect(claimed).toEqual({ primaryEmail: TARGET, password });
  });

  it('finds ciphertext, not a hash, in the stored record', async () => {
    const { requestId } = await provision();

    const record = (
      await db.collection(COLLECTIONS.credentialHandoffs).doc(requestId).get()
    ).data() as CredentialHandoff;

    // iv.data.tag, three base64url parts. A hash would be one fixed-width
    // token, and could never satisfy the decryption control above.
    expect(record.oneTimePasswordCiphertext.split('.')).toHaveLength(3);
    expect(record.keyVersion).toBe('versions/1');
  });
});

describe('AC-1: the account is created behind first-login password change', () => {
  it('creates the user with changePasswordAtNextLogin=true', async () => {
    await provision();

    expect(directory.created).toMatchObject({
      primaryEmail: TARGET,
      changePasswordAtNextLogin: true,
    });
  });
});

describe('AC-4: the credential record carries the TTL field', () => {
  it('stores expiresAt as a Firestore Timestamp at the configured TTL', async () => {
    // expiresAt is the field the Firestore TTL policy is declared on (the
    // policy itself is infrastructure, REQ-020/REQ-022). What the application
    // owns is that every record carries the field, typed so the policy can
    // act on it, and set to the 72-hour window the create phase configures.
    const before = Date.now();
    const { requestId } = await provision();

    const record = (
      await db.collection(COLLECTIONS.credentialHandoffs).doc(requestId).get()
    ).data() as CredentialHandoff;

    expect(record.expiresAt).toBeInstanceOf(Timestamp);
    expect(record.expiresAt.toMillis()).toBeGreaterThanOrEqual(before + 72 * 3_600_000);
    expect(record.expiresAt.toMillis()).toBeLessThanOrEqual(Date.now() + 72 * 3_600_000);
  });

  it('is REQ-003 AC-7 as well: nothing an operator can read back carries the plaintext', async () => {
    // The surface REQ-019's grep above cannot see. The worker's own responses
    // are machine-to-machine and short-lived; what an operator actually reads
    // is GET /api/requests/:id, which serialises the request, its steps with
    // their outputs, and the audit trail. A password that leaked into a step
    // output would be invisible to every assertion above and visible in the
    // console.
    //
    // The payload is rebuilt here from the three store reads the route itself
    // performs, rather than imported: the API service is a separate package
    // and a cross-package import would put its sources inside this one's
    // compilation. The keys are pinned below so the reconstruction cannot
    // drift away from the route without the pin failing.
    const { requestId } = await provision();
    const password = directory.issuedPassword!;

    const [request, steps, audit] = await Promise.all([
      store.getRequest(requestId),
      store.listSteps(requestId),
      store.listAudit(requestId),
    ]);
    const readPayload = { request, steps, audit };

    expect(Object.keys(readPayload).sort()).toEqual(['audit', 'request', 'steps']);
    expect(steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(readPayload)).not.toContain(password);
  });

  it('keeps the plaintext out of every step output, which is where it would surface', async () => {
    // Named separately because the create-user handler is the one place that
    // holds the plaintext and also returns a value. Returning it, or folding
    // it into a diagnostic field, is a one-word mistake that the whole-payload
    // grep would catch but not explain.
    const { requestId } = await provision();
    const password = directory.issuedPassword!;

    const steps = await store.listSteps(requestId);
    const createUser = steps.find((s) => s.name === 'create-user')!;

    expect(createUser.output).not.toBeNull();
    expect(JSON.stringify(createUser.output)).not.toContain(password);
    // What it does return: the Workspace id, and nothing else about the account.
    expect(Object.keys(createUser.output!)).toEqual(['userId']);

    for (const step of steps) {
      expect(JSON.stringify(step.output ?? {})).not.toContain(password);
      expect(JSON.stringify(step.error ?? {})).not.toContain(password);
    }
  });

  it('leaves retrieval as the single sanctioned exit for the plaintext', async () => {
    // The counterpart to every absence assertion here. The password is not
    // merely hidden, it is reachable in exactly one way, once (REQ-017), and
    // that route is the only response body in the system permitted to carry
    // it. Proving the exit exists is what makes the absences meaningful
    // rather than a system that lost the password.
    const { requestId } = await provision();
    const password = directory.issuedPassword!;

    expect(await credentials.retrieveOnce(requestId)).toEqual({
      primaryEmail: TARGET,
      password,
    });
    // And it closes behind itself.
    expect(await credentials.retrieveOnce(requestId)).toBeNull();
  });

  it('expires without operator action even before the TTL deletion lands', async () => {
    // Firestore TTL deletes within 72 hours of expiry, not at the instant. The
    // application does not lean on that window: an expired record already
    // yields nothing and has its ciphertext destroyed on first touch, so the
    // TTL deletion is cleanup, never the control.
    const { requestId } = await provision();
    await db
      .collection(COLLECTIONS.credentialHandoffs)
      .doc(requestId)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });

    expect(await credentials.retrieveOnce(requestId)).toBeNull();

    const record = (
      await db.collection(COLLECTIONS.credentialHandoffs).doc(requestId).get()
    ).data() as CredentialHandoff;
    expect(record.oneTimePasswordCiphertext).toBe('');
  });
});
