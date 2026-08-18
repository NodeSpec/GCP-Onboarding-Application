import { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  LifecycleStore,
  type OperatorRole,
} from '@lifecycle/shared';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OperatorIdentity } from '../middleware/iapAuth.js';
import { ProtectedAccounts } from '../protectedAccounts.js';
import { requestRoutes } from './requests.js';

/**
 * TC-REQ-031-1, -5 and -6: the admission guard, against the real route.
 *
 * AC-1's claim is not "the API answers 409" but "no request or step document is
 * persisted", and that cannot be shown by calling a matcher — a guard that
 * refused AFTER writing would return the same status. So this drives the real
 * submission route against the emulator and asserts on the collections
 * afterwards.
 *
 * AC-6 is the one most easily got wrong in a way nobody notices: protection is
 * a property of the TARGET, not a permission level, so the admin role has to be
 * refused exactly as a requester is. A guard placed after a role check, or one
 * that exempted admins "for break-glass", would pass every other test here.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const OPERATOR = 'operator@company.com';
const SENDER = 'noreply@company.com';
const RETURN_PATH = 'bounces@company.com';
const BREAKGLASS = 'breakglass@company.com';
const ORDINARY = 'ada.lovelace@company.com';

const protectedAccounts = new ProtectedAccounts({
  configured: [BREAKGLASS],
  sender: SENDER,
  returnPathGroup: RETURN_PATH,
});

const silentDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

let identity: OperatorIdentity = { email: OPERATOR, subject: 'sub-1' };
let roles: OperatorRole[] = ['requester'];
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
      dispatcher: silentDispatcher,
      resolver: { async rolesFor() { return roles; } },
      protectedAccounts,
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
  roles = ['requester'];
  await wipe();
});

const payloadFor = (phase: string, primaryEmail: string) => {
  if (phase === 'create') {
    return { primaryEmail, givenName: 'Ada', familyName: 'Lovelace' };
  }
  if (phase === 'update') return { primaryEmail, title: 'Principal Engineer' };
  return { primaryEmail };
};

const submit = (phase: string, primaryEmail: string) =>
  fetch(`${base}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phase, payload: payloadFor(phase, primaryEmail) }),
  });

/** Counts everything the submission path could have written. */
async function persisted() {
  const requests = await db.collection(COLLECTIONS.requests).get();
  let steps = 0;
  for (const doc of requests.docs) {
    steps += (await doc.ref.collection(COLLECTIONS.steps).get()).size;
  }
  return { requests: requests.size, steps };
}

describe('AC-1: a request targeting a protected account is refused at admission', () => {
  it.each(['create', 'update', 'delete'])('refuses a %s request with 409', async (phase) => {
    const res = await submit(phase, SENDER);
    const body = (await res.json()) as { error: string; protectedAccount: string };

    expect(res.status).toBe(409);
    expect(body.error).toBe('protected_account');
    expect(body.protectedAccount).toBe(SENDER);
  });

  it('persists no request and no step', async () => {
    // The actual content of AC-1. A guard that refused after writing would
    // answer 409 just the same.
    await submit('delete', SENDER);

    expect(await persisted()).toEqual({ requests: 0, steps: 0 });
  });

  it('refuses the Return-Path group and a configured break-glass account too', async () => {
    for (const target of [RETURN_PATH, BREAKGLASS]) {
      expect((await submit('delete', target)).status).toBe(409);
    }
    expect(await persisted()).toEqual({ requests: 0, steps: 0 });
  });

  it('refuses an aliased form of a protected address', async () => {
    // Reaching the same mailbox by another spelling must not get past the
    // guard, or the protection is decorative.
    const res = await submit('delete', 'no.reply+urgent@company.com');

    expect(res.status).toBe(409);
    expect(await persisted()).toEqual({ requests: 0, steps: 0 });
  });

  it('admits an ordinary target, which is what makes the refusals meaningful', async () => {
    // The control. Without it every assertion above would hold for a route that
    // refused everything.
    const res = await submit('delete', ORDINARY);

    expect(res.status).toBe(201);
    expect((await persisted()).requests).toBe(1);
  });
});

describe('AC-6: protection is not a permission level', () => {
  it('refuses an admin exactly as it refuses a requester', async () => {
    roles = ['requester', 'approver', 'admin'];

    const res = await submit('delete', SENDER);

    expect(res.status).toBe(409);
    expect(await persisted()).toEqual({ requests: 0, steps: 0 });
  });

  it('refuses every role combination', async () => {
    for (const set of [['requester'], ['requester', 'approver'], ['requester', 'admin']] as OperatorRole[][]) {
      roles = set;
      expect((await submit('delete', SENDER)).status).toBe(409);
    }
  });
});

describe('AC-5: the refusal is audited', () => {
  it('records the operator, the protected account, and the action attempted', async () => {
    await submit('delete', SENDER);

    const events = await store.listAllAudit({ limit: 20 });
    const refusal = events.find((e) => e.action === 'request.protected_account_refused')!;

    expect(refusal).toBeDefined();
    expect(refusal.actor.email).toBe(OPERATOR);
    expect(refusal.targetUser).toBe(SENDER);
    expect(refusal.outcome).toBe('denied');
    // The phase attempted, so the record answers "what were they trying to do".
    expect(JSON.stringify(refusal.after)).toContain('delete');
  });

  it('audits the attempt even though nothing was persisted', async () => {
    // An attempt to offboard the account that sends every welcome letter is
    // exactly the signal a security team wants, and it would be invisible if
    // the audit were written alongside a request document that never exists.
    await submit('delete', SENDER);

    expect(await persisted()).toEqual({ requests: 0, steps: 0 });
    expect(
      (await store.listAllAudit({ limit: 20 })).some(
        (e) => e.action === 'request.protected_account_refused',
      ),
    ).toBe(true);
  });

  it('names which protected account was targeted, not merely that one was', async () => {
    await submit('update', BREAKGLASS);

    const refusal = (await store.listAllAudit({ limit: 20 })).find(
      (e) => e.action === 'request.protected_account_refused',
    )!;

    expect(refusal.targetUser).toBe(BREAKGLASS);
  });
});
