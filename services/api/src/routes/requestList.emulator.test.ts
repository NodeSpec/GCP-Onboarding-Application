import { Firestore } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type OperatorRole,
} from '@lifecycle/shared';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OperatorIdentity } from '../middleware/iapAuth.js';
import { requestRoutes } from './requests.js';

/**
 * TC-REQ-011-4 and TC-REQ-011-6: the request list and the approvals inbox.
 *
 * Both are server-side claims that a unit test would be free to fake. "Filters
 * and paginates without loading the full collection" is about what the QUERY
 * does, so it is exercised against the emulator with more requests than a page;
 * and "shows only what this operator may approve" is about the interaction of a
 * snapshot policy, a role set, and the requester's identity, which needs real
 * halted requests to be meaningful.
 *
 * The inbox's exclusions are the part worth being careful about. An inbox that
 * merely hid the button would still be showing an approver work they cannot do,
 * and one that read live policy instead of the snapshot would disagree with the
 * route that actually accepts the decision.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const OPERATOR = 'operator@company.com';
const OTHER = 'colleague@company.com';
const ACTOR: AuditActor = { kind: 'human', email: OPERATOR };

const silentDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

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
      dispatcher: silentDispatcher,
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
  await wipe();
});

/** Persists one request directly, so a list can be staged without dispatching. */
async function seed(options: {
  phase: 'create' | 'update' | 'delete';
  targetUser: string;
  requestedBy?: string;
  policy?: ApprovalPolicy;
  start?: boolean;
}) {
  const { phase, targetUser } = options;
  const payload =
    phase === 'create'
      ? { primaryEmail: targetUser, givenName: 'Ada', familyName: 'Lovelace' }
      : phase === 'update'
        ? { primaryEmail: targetUser, title: 'Principal Engineer' }
        : { primaryEmail: targetUser };

  const documents = buildNewRequest({
    phase,
    targetUser,
    requestedBy: options.requestedBy ?? OPERATOR,
    payload,
    plan: stepPlanFor(phase, payload),
    policy: options.policy ?? DEFAULT_POLICY,
  });
  await store.createRequest(documents, {
    kind: 'human',
    email: options.requestedBy ?? OPERATOR,
  });
  if (options.start !== false) {
    await store.startFirstStep(documents.request.requestId, {
      kind: 'human',
      email: options.requestedBy ?? OPERATOR,
    });
  }
  return documents.request.requestId;
}

/**
 * Halts a request on a named step, through the real transition guard rather
 * than by writing the state directly.
 *
 * Needed because no phase's FIRST step requires approval under the default
 * policy: a delete halts on delete-user only once the plan has walked past
 * suspend, revoke and remove-memberships, and driving that here would mean
 * importing the worker's executor into this package's compilation. Staging it
 * through the guard keeps the halted state one the state machine actually
 * allows.
 */
async function haltOn(requestId: string, stepName: string) {
  const step = (await store.listSteps(requestId)).find((s) => s.name === stepName)!;

  await store.transitionStep({
    requestId,
    stepId: step.stepId,
    expectedFrom: 'pending',
    to: 'awaiting_approval',
    audit: { actor: ACTOR, action: 'step.halted' },
  });
  await store.transitionRequest({
    requestId,
    expectedFrom: 'running',
    to: 'awaiting_approval',
    audit: { actor: ACTOR, action: 'request.awaiting_approval' },
  });
}

const list = (query = '') => fetch(`${base}/api/requests${query}`);
const inbox = () => fetch(`${base}/api/requests/inbox/approvals`);

interface ListBody {
  requests: { requestId: string; phase: string; status: string; targetUser: string }[];
  nextCursor: string | null;
}

describe('AC-4: the request list filters and paginates server-side', () => {
  it('returns the requests that exist', async () => {
    await seed({ phase: 'create', targetUser: 'a@company.com' });
    await seed({ phase: 'delete', targetUser: 'b@company.com' });

    const body = (await (await list()).json()) as ListBody;

    expect(body.requests).toHaveLength(2);
  });

  it('filters by phase', async () => {
    await seed({ phase: 'create', targetUser: 'a@company.com' });
    await seed({ phase: 'delete', targetUser: 'b@company.com' });

    const body = (await (await list('?phase=delete')).json()) as ListBody;

    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]!.phase).toBe('delete');
  });

  it('filters by target user', async () => {
    await seed({ phase: 'create', targetUser: 'a@company.com' });
    await seed({ phase: 'delete', targetUser: 'b@company.com' });

    const body = (await (await list('?targetUser=b@company.com')).json()) as ListBody;

    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]!.targetUser).toBe('b@company.com');
  });

  it('filters by status', async () => {
    await seed({ phase: 'create', targetUser: 'a@company.com' });
    const halted = await seed({ phase: 'delete', targetUser: 'b@company.com' });
    await haltOn(halted, 'delete-user');

    const body = (await (await list('?status=awaiting_approval')).json()) as ListBody;

    // Asserted on the contents, not merely that every row matches: an empty
    // list would satisfy the latter and prove nothing about the filter.
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]!.requestId).toBe(halted);
  });

  it('refuses an unknown phase or status rather than matching nothing', async () => {
    // A silently empty list reads as "no such requests", which is a different
    // and much more confusing answer than "that is not a status".
    expect((await list('?phase=banana')).status).toBe(400);
    expect((await list('?status=nonsense')).status).toBe(400);
  });

  it('pages with a cursor, returning each request exactly once', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seed({ phase: 'create', targetUser: `user${i}@company.com` });
    }

    const first = (await (await list('?limit=2')).json()) as ListBody;
    const second = (await (await list(`?limit=2&cursor=${first.nextCursor}`)).json()) as ListBody;
    const third = (await (await list(`?limit=2&cursor=${second.nextCursor}`)).json()) as ListBody;

    expect(first.requests).toHaveLength(2);
    expect(second.requests).toHaveLength(2);
    expect(third.requests).toHaveLength(1);

    const seen = [...first.requests, ...second.requests, ...third.requests].map((r) => r.requestId);
    expect(new Set(seen).size).toBe(5);
  });

  it('reports no cursor on the last page', async () => {
    await seed({ phase: 'create', targetUser: 'a@company.com' });

    const body = (await (await list('?limit=25')).json()) as ListBody;

    expect(body.nextCursor).toBeNull();
  });

  it('refuses a malformed cursor rather than failing as a server error', async () => {
    expect((await list('?cursor=not-a-cursor')).status).toBe(400);
  });

  it('omits the payload, which a list row has no use for', async () => {
    // A create payload carries the person's name, title, manager and groups.
    // None of that belongs on the wire to draw a table.
    await seed({ phase: 'create', targetUser: 'ada.lovelace@company.com' });

    const text = await (await list()).text();

    expect(text).not.toContain('Lovelace');
    expect(text).toContain('ada.lovelace@company.com');
  });

  it('is reachable at the collection root without colliding with :requestId', async () => {
    // The route-ordering trap: '/' and '/inbox/approvals' both have to be
    // declared before '/:requestId', or Express answers them as a lookup for a
    // request whose id is 'inbox'.
    await seed({ phase: 'create', targetUser: 'a@company.com' });

    expect((await list()).status).toBe(200);
    expect((await inbox()).status).toBe(200);
  });
});

interface InboxBody {
  approvals: {
    requestId: string;
    requestedBy: string;
    step: { name: string; requiredRole: string };
    computedDiff: unknown;
  }[];
}

describe('AC-6: the inbox shows only what this operator may approve', () => {
  it('shows a halted request raised by someone else', async () => {
    const id = await seed({ phase: 'delete', targetUser: 'leaver@company.com', requestedBy: OTHER });
    await haltOn(id, 'delete-user');

    const body = (await (await inbox()).json()) as InboxBody;

    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.step.name).toBe('delete-user');
    expect(body.approvals[0]!.requestedBy).toBe(OTHER);
  });

  it('never shows the operator their own request', async () => {
    // REQ-002's self-approval prohibition, surfaced rather than left for the
    // approve route to refuse. Rendering it and disabling the button would
    // invite someone to go looking for another way round.
    const id = await seed({ phase: 'delete', targetUser: 'leaver@company.com', requestedBy: OPERATOR });
    await haltOn(id, 'delete-user');

    const body = (await (await inbox()).json()) as InboxBody;

    expect(body.approvals).toHaveLength(0);
  });

  it('hides work whose required role the operator does not hold', async () => {
    // delete-user requires admin under the mandatory floor. An approver without
    // it would be refused by the approve route, so showing it would be an
    // invitation to a 403.
    const id = await seed({ phase: 'delete', targetUser: 'leaver@company.com', requestedBy: OTHER });
    await haltOn(id, 'delete-user');
    roles = ['requester', 'approver'];

    const body = (await (await inbox()).json()) as InboxBody;

    expect(body.approvals).toHaveLength(0);
  });

  it('shows the same work once the operator holds the required role', async () => {
    // The control for the exclusion above: the only thing that changed is the
    // role set.
    const id = await seed({ phase: 'delete', targetUser: 'leaver@company.com', requestedBy: OTHER });
    await haltOn(id, 'delete-user');
    roles = ['requester', 'approver', 'admin'];

    const body = (await (await inbox()).json()) as InboxBody;

    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.step.requiredRole).toBe('admin');
  });

  it('resolves the required role through the mandatory floor, not the snapshot alone', async () => {
    // A snapshot that says NOTHING about delete-user still yields an admin
    // requirement, because the floor is resolved where policy is read and an
    // unconfigured irreversible step defaults to the higher role. An inbox that
    // fell through to the generic 'approver' default would show the one action
    // nobody can take back to someone who cannot authorise it.
    const silent: ApprovalPolicy = { ...DEFAULT_POLICY, delete: {} };
    const id = await seed({
      phase: 'delete',
      targetUser: 'leaver@company.com',
      requestedBy: OTHER,
      policy: silent,
    });
    await haltOn(id, 'delete-user');
    roles = ['requester', 'approver'];

    expect(((await (await inbox()).json()) as InboxBody).approvals).toHaveLength(0);
  });

  it('honours an explicitly configured approver role, which the floor does not raise', async () => {
    // The floor forces approval ON; it does not overrule a tenant that decided
    // WHO may give it. Pinned because the two halves are easy to conflate, and
    // an inbox that raised the role would hide work its approver may act on.
    const configured: ApprovalPolicy = {
      ...DEFAULT_POLICY,
      delete: { 'delete-user': { requiresApproval: false, approverRole: 'approver' } },
    };
    const id = await seed({
      phase: 'delete',
      targetUser: 'leaver@company.com',
      requestedBy: OTHER,
      policy: configured,
    });
    await haltOn(id, 'delete-user');
    roles = ['requester', 'approver'];

    const body = (await (await inbox()).json()) as InboxBody;

    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.step.requiredRole).toBe('approver');
  });

  it('shows nothing when no request is halted', async () => {
    await seed({ phase: 'create', targetUser: 'a@company.com', requestedBy: OTHER });

    expect(((await (await inbox()).json()) as InboxBody).approvals).toHaveLength(0);
  });

  it('carries the computed diff so an approver sees what will change', async () => {
    // REQ-011 AC-9's inbox half. Null here because the update has not reached
    // its diff step, and the field being present-and-null is what lets the
    // console distinguish "nothing computed yet" from "no diff on this phase".
    const id = await seed({ phase: 'delete', targetUser: 'leaver@company.com', requestedBy: OTHER });
    await haltOn(id, 'delete-user');

    const body = (await (await inbox()).json()) as InboxBody;

    expect(body.approvals[0]).toHaveProperty('computedDiff');
  });

  it('refuses an identity without the approver role outright', async () => {
    roles = ['requester'];

    expect((await inbox()).status).toBe(403);
  });
});
