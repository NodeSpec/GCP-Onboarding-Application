import { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  LifecycleStore,
  type ApprovalPolicy,
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
import { requestRoutes } from './requests.js';
import { roleBindingRoutes } from './roleBindings.js';

/**
 * TC-REQ-012-1, 3, 4, 6 and 8, over HTTP against the real binding store.
 *
 * AC-8 is explicit that authorization must be proven by calling the API
 * directly rather than through the console, so every case here drives the
 * routes with an identity and nothing else. There is no UI in the loop to hide
 * a control, which is the point: hiding one is never the enforcement.
 *
 * The resolver is the real BindingRoleResolver over the real store, so a role
 * only exists here because a binding was written. Only IAP and Cloud Tasks are
 * substituted.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const VALID = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  groups: ['engineering@company.com'],
};

/** Halts the first step, so approval routes have something to act on. */
const HALT_FIRST: ApprovalPolicy = {
  ...DEFAULT_POLICY,
  create: { 'validate-request': { requiresApproval: true, approverRole: 'approver' } },
};

class NullDispatcher implements TaskDispatcher {
  async enqueueStep(_input: EnqueueStepInput) {}
  async enqueueApproverNotification(_input: { requestId: string; stepId: string }) {}
  async enqueueApprovalExpiry(_input: { requestId: string; stepId: string }) {}
}

const BOOTSTRAP = 'root@company.com';

let identity: OperatorIdentity = { email: BOOTSTRAP, subject: 'sub-root' };
let policy: ApprovalPolicy = DEFAULT_POLICY;

const resolver = new BindingRoleResolver(store, { bootstrapAdmins: [BOOTSTRAP] });

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
    requestRoutes({ store, loadPolicy: async () => policy, dispatcher: new NullDispatcher(), resolver }),
  );
  app.use(
    '/api/role-bindings',
    roleBindingRoutes({ store, resolver, onChanged: (s) => resolver.invalidate(s) }),
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
  for (const collection of [COLLECTIONS.requests, COLLECTIONS.audit, COLLECTIONS.roleBindings]) {
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
  identity = { email: BOOTSTRAP, subject: 'sub-root' };
  policy = DEFAULT_POLICY;
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

const submit = (payload: unknown = VALID) =>
  call('/api/requests', { method: 'POST', body: JSON.stringify({ phase: 'create', payload }) });

/** Grants a binding as the bootstrap admin, then restores the caller. */
async function grant(subject: string, roles: string[], kind: 'user' | 'group' = 'user') {
  const previous = identity;
  as(BOOTSTRAP);
  const res = await call(`/api/role-bindings/${subject}`, {
    method: 'PUT',
    body: JSON.stringify({ kind, roles }),
  });
  identity = previous;
  return res;
}

async function auditFor(subject: string): Promise<AuditEvent[]> {
  const snap = await db.collection(COLLECTIONS.audit).get();
  return snap.docs
    .map((d) => d.data() as AuditEvent)
    .filter((e) => e.targetUser === subject && e.action.startsWith('roleBinding.'));
}

describe('AC-1 and AC-2: no binding means no access, on every route', () => {
  it('refuses a submission from an identity with no binding', async () => {
    as('nobody@company.com');

    const res = await submit();

    expect(res.status).toBe(403);
    expect(((await res.json()) as { requiredRole: string }).requiredRole).toBe('requester');
    // Refused before the handler: nothing was written.
    expect((await db.collection(COLLECTIONS.requests).get()).size).toBe(0);
  });

  it('refuses a read from an identity with no binding', async () => {
    await grant('ada@company.com', ['requester']);
    as('ada@company.com');
    const created = (await (await submit()).json()) as { requestId: string };

    as('nobody@company.com');
    expect((await call(`/api/requests/${created.requestId}`)).status).toBe(403);
  });

  it('refuses the role binding routes to an identity with no binding', async () => {
    as('nobody@company.com');

    expect((await call('/api/role-bindings')).status).toBe(403);
    expect(
      (await call('/api/role-bindings/x@company.com', {
        method: 'PUT',
        body: JSON.stringify({ kind: 'user', roles: ['admin'] }),
      })).status,
    ).toBe(403);
    expect((await call('/api/role-bindings/x@company.com', { method: 'DELETE' })).status).toBe(403);
  });

  it('lets the bootstrap admin in when the store is empty', async () => {
    as(BOOTSTRAP);

    const res = await call('/api/role-bindings');

    expect(res.status).toBe(200);
    expect(((await res.json()) as { bindings: unknown[] }).bindings).toEqual([]);
  });
});

describe('AC-3: the requester role can submit but never approve', () => {
  it('admits a submission', async () => {
    await grant('ada@company.com', ['requester']);
    as('ada@company.com');

    expect((await submit()).status).toBe(201);
  });

  it('refuses approval of a request created by someone else', async () => {
    policy = HALT_FIRST;
    await grant('bob@company.com', ['requester']);
    await grant('ada@company.com', ['requester']);

    as('bob@company.com');
    const created = (await (await submit()).json()) as {
      requestId: string;
      firstStep: { stepId: string };
    };

    // A different person, still only a requester. The role is what is missing,
    // not the distinctness.
    as('ada@company.com');
    const res = await call(
      `/api/requests/${created.requestId}/steps/${created.firstStep.stepId}/approve`,
      { method: 'POST', body: JSON.stringify({ justification: 'looks fine' }) },
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { requiredRole: string }).requiredRole).toBe('approver');
    expect((await store.listSteps(created.requestId))[0]!.status).toBe('awaiting_approval');
  });
});

describe('AC-4: the approver role approves for others, never for itself', () => {
  it('approves a request created by someone else', async () => {
    policy = HALT_FIRST;
    await grant('bob@company.com', ['requester']);
    await grant('ada@company.com', ['requester', 'approver']);

    as('bob@company.com');
    const created = (await (await submit()).json()) as {
      requestId: string;
      firstStep: { stepId: string };
    };

    as('ada@company.com');
    const res = await call(
      `/api/requests/${created.requestId}/steps/${created.firstStep.stepId}/approve`,
      { method: 'POST', body: JSON.stringify({ justification: 'checked the ticket' }) },
    );

    expect(res.status).toBe(200);
    expect((await store.listSteps(created.requestId))[0]!.status).toBe('ready');
  });

  it('is still refused approval of its own request', async () => {
    policy = HALT_FIRST;
    await grant('ada@company.com', ['requester', 'approver']);

    as('ada@company.com');
    const created = (await (await submit()).json()) as {
      requestId: string;
      firstStep: { stepId: string };
    };

    const res = await call(
      `/api/requests/${created.requestId}/steps/${created.firstStep.stepId}/approve`,
      { method: 'POST', body: JSON.stringify({ justification: 'mine, and I like it' }) },
    );

    // Holding the role is not enough: two-party approval needs a second party,
    // and that check lives in the store against the persisted requester.
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('self_approval_refused');
    expect((await store.listSteps(created.requestId))[0]!.status).toBe('awaiting_approval');
  });
});

describe('AC-6: binding changes are audited with actor, subject and before/after', () => {
  it('records a grant with no previous roles', async () => {
    const res = await grant('ada@company.com', ['requester']);
    expect(res.status).toBe(201);

    const events = await auditFor('ada@company.com');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'roleBinding.set',
      actor: { kind: 'human', email: BOOTSTRAP },
      targetUser: 'ada@company.com',
      before: null,
      after: { roles: ['requester'], kind: 'user' },
    });
    // Not about a lifecycle request, and it does not pretend to be.
    expect(events[0]!.requestId).toBeNull();
  });

  it('records the roles before and after an escalation', async () => {
    await grant('ada@company.com', ['requester']);
    const res = await grant('ada@company.com', ['requester', 'admin']);

    // 200, not 201: this replaced a binding rather than creating one.
    expect(res.status).toBe(200);

    const escalation = (await auditFor('ada@company.com')).find(
      (e) => (e.after as { roles: string[] }).roles.includes('admin'),
    );
    expect(escalation!.before).toEqual({ roles: ['requester'] });
    expect(escalation!.after).toMatchObject({ roles: ['admin', 'requester'] });
  });

  it('records a removal with the roles that were lost', async () => {
    await grant('ada@company.com', ['approver']);
    as(BOOTSTRAP);

    const res = await call('/api/role-bindings/ada@company.com', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const removal = (await auditFor('ada@company.com')).find(
      (e) => e.action === 'roleBinding.removed',
    );
    expect(removal!.before).toEqual({ roles: ['approver'] });
    expect(removal!.after).toEqual({ roles: [] });
  });

  it('reports 404 for removing a binding that does not exist, and audits nothing', async () => {
    as(BOOTSTRAP);

    const res = await call('/api/role-bindings/ghost@company.com', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await auditFor('ghost@company.com')).toHaveLength(0);
  });
});

describe('a revoked role stops working immediately', () => {
  it('refuses a submission once the binding is removed', async () => {
    await grant('ada@company.com', ['requester']);
    as('ada@company.com');
    expect((await submit()).status).toBe(201);

    as(BOOTSTRAP);
    await call('/api/role-bindings/ada@company.com', { method: 'DELETE' });

    as('ada@company.com');
    expect((await submit({ ...VALID, primaryEmail: 'grace@company.com' })).status).toBe(403);
  });
});

describe('the binding payload is validated', () => {
  it('refuses an empty role list rather than treating it as a removal', async () => {
    as(BOOTSTRAP);

    const res = await call('/api/role-bindings/ada@company.com', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'user', roles: [] }),
    });

    expect(res.status).toBe(400);
    expect(await store.getRoleBinding('ada@company.com')).toBeNull();
  });

  it('refuses an unknown role', async () => {
    as(BOOTSTRAP);

    const res = await call('/api/role-bindings/ada@company.com', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'user', roles: ['superuser'] }),
    });

    expect(res.status).toBe(400);
  });

  it('refuses a subject that is not an email address', async () => {
    as(BOOTSTRAP);

    const res = await call('/api/role-bindings/not-an-email', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'user', roles: ['requester'] }),
    });

    expect(res.status).toBe(400);
  });
});
