import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireCaller, type CallerClaims } from '../auth/taskAuth.js';
import { WorkspaceError } from '../workspace/directoryClient.js';
import { lookupRoutes } from './lookup.js';

/**
 * TC-REQ-029-1 through -9, and the isolation half of REQ-016 AC-8.
 *
 * Two claims here cannot be shown by calling a handler directly. That the
 * lookup surface is READ-ONLY is a property of what the router can reach, so it
 * is asserted against a Directory double whose mutating methods throw if they
 * are ever called — a stub that simply omitted them would pass whether or not
 * the router tried. And that each identity is confined to its own route class
 * is a property of the mounting, so the app under test mounts both routers the
 * way the entry point does and drives them over real HTTP.
 *
 * AC-9 spans both halves — a lookup, then an execution that must not trust it —
 * so it is exercised at the end of this file rather than split across two
 * suites where neither would show the sequence that matters.
 */

const QUEUE_SA = 'queue@company-project.iam.gserviceaccount.com';
const API_SA = 'api@company-project.iam.gserviceaccount.com';
const AUDIENCE = 'https://lifecycle-worker.example.com';

/**
 * A Directory stand-in whose every MUTATING method throws. The read-only claim
 * is that no lookup route reaches one of these, and a double that left them out
 * would make that assertion vacuous.
 */
class ReadOnlyProbe {
  readonly calls: string[] = [];
  users = new Map<string, Record<string, unknown>>();
  memberships = new Map<string, string[]>();
  groups = [
    { email: 'engineering@company.com', name: 'Engineering', description: 'Engineers' },
    { email: 'platform@company.com', name: 'Platform', description: '' },
  ];
  orgUnits = [
    { orgUnitPath: '/Engineering', name: 'Engineering' },
    { orgUnitPath: '/Sales', name: 'Sales' },
  ];
  failWith: unknown = null;

  private read(op: string) {
    this.calls.push(op);
    if (this.failWith) throw this.failWith;
  }

  private forbidden(op: string): never {
    throw new Error(`lookup reached a mutating Directory method: ${op}`);
  }

  async searchUsers(query: string, limit: number, pageToken?: string) {
    this.read(`searchUsers:${query}:${limit}:${pageToken ?? ''}`);
    const users = [...this.users.values()].map((u) => ({
      primaryEmail: u.primaryEmail as string,
      fullName: (u.name as { fullName?: string } | undefined)?.fullName ?? '',
      orgUnitPath: (u.orgUnitPath as string) ?? '/',
      suspended: u.suspended === true,
    }));
    return pageToken ? { users, nextPageToken: 'page-2' } : { users };
  }

  async getUser(primaryEmail: string) {
    this.read(`getUser:${primaryEmail}`);
    return this.users.get(primaryEmail.toLowerCase()) ?? null;
  }

  async listMemberships(memberEmail: string) {
    this.read(`listMemberships:${memberEmail}`);
    return this.memberships.get(memberEmail.toLowerCase()) ?? [];
  }

  async listGroups(limit: number) {
    this.read(`listGroups:${limit}`);
    return this.groups.slice(0, limit);
  }

  async listOrgUnits() {
    this.read('listOrgUnits');
    return this.orgUnits;
  }

  // Every mutation the Directory client exposes. Reaching any of these fails.
  async insertUser() { this.forbidden('insertUser'); }
  async updateUser() { this.forbidden('updateUser'); }
  async patchUser() { this.forbidden('patchUser'); }
  async deleteUser() { this.forbidden('deleteUser'); }
  async setSuspended() { this.forbidden('setSuspended'); }
  async resetPassword() { this.forbidden('resetPassword'); }
  async addMember() { this.forbidden('addMember'); }
  async removeMember() { this.forbidden('removeMember'); }
  async revokeTokens() { this.forbidden('revokeTokens'); }
  async startDriveTransfer() { this.forbidden('startDriveTransfer'); }

  reset() {
    this.calls.length = 0;
    this.failWith = null;
    this.users = new Map([
      [
        'ada.lovelace@company.com',
        {
          primaryEmail: 'ada.lovelace@company.com',
          name: { givenName: 'Ada', familyName: 'Lovelace', fullName: 'Ada Lovelace' },
          orgUnitPath: '/Engineering',
          suspended: false,
          organizations: [{ title: 'Staff Engineer', department: 'Platform', primary: true }],
          relations: [{ value: 'grace.hopper@company.com', type: 'manager' }],
        },
      ],
    ]);
    this.memberships = new Map([['ada.lovelace@company.com', ['engineering@company.com']]]);
  }
}

const directory = new ReadOnlyProbe();

/** Admits whichever service account the test names, so identity is the variable. */
const verifier = (email: string) => async (): Promise<CallerClaims> => ({
  email,
  email_verified: true,
});

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Mounted the way the entry point mounts them: the lookup router behind the
  // API service identity, a stand-in task route behind the queue identity. The
  // isolation claim is about this arrangement, not about either router alone.
  app.use(
    '/lookup',
    requireCaller('api-service', {
      verifyToken: verifier(API_SA),
      audience: AUDIENCE,
      expectedEmail: API_SA,
    }),
    lookupRoutes({ directory: directory as never }),
  );

  app.use(
    '/tasks',
    requireCaller('cloud-tasks', {
      verifyToken: verifier(API_SA),
      audience: AUDIENCE,
      expectedEmail: QUEUE_SA,
    }),
    express.Router().post('/execute-step', (_req, res) => res.status(200).json({ ok: true })),
  );

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => directory.reset());

const get = (path: string, token = 'any-token') =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

describe('AC-1: a prefix search returns matching users, paginated', () => {
  it('returns primaryEmail, name, org unit and suspended for each match', async () => {
    const res = await get('/lookup/users?q=ada');
    const body = (await res.json()) as { users: Record<string, unknown>[] };

    expect(res.status).toBe(200);
    expect(body.users[0]).toEqual({
      primaryEmail: 'ada.lovelace@company.com',
      fullName: 'Ada Lovelace',
      orgUnitPath: '/Engineering',
      suspended: false,
    });
  });

  it('searches by prefix rather than fetching the domain and filtering', async () => {
    // The distinction that makes the page size mean something: the query goes
    // to Workspace, so a large domain is never enumerated into this process.
    await get('/lookup/users?q=ada');

    expect(directory.calls[0]).toContain('searchUsers:email:ada*');
  });

  it('paginates, passing the page token through and returning the next one', async () => {
    const res = await get('/lookup/users?q=ada&pageToken=page-1');
    const body = (await res.json()) as { nextPageToken?: string };

    expect(directory.calls[0]).toContain(':page-1');
    expect(body.nextPageToken).toBe('page-2');
  });

  it('caps the page size so a caller cannot ask for the whole domain', async () => {
    await get('/lookup/users?q=ada&limit=5000');

    expect(directory.calls[0]).toContain(':100:');
  });

  it('requires a query rather than listing every user', async () => {
    expect((await get('/lookup/users?q=')).status).toBe(400);
    expect((await get('/lookup/users')).status).toBe(400);
  });
});

describe('AC-2: one user carries enough to pre-fill an update request', () => {
  it('returns attributes and memberships together', async () => {
    const res = await get('/lookup/users/ada.lovelace@company.com');
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      primaryEmail: 'ada.lovelace@company.com',
      givenName: 'Ada',
      familyName: 'Lovelace',
      orgUnitPath: '/Engineering',
      title: 'Staff Engineer',
      department: 'Platform',
      managerEmail: 'grace.hopper@company.com',
      groups: ['engineering@company.com'],
    });
  });

  it('reports an absent attribute as null rather than omitting it', async () => {
    // The update form distinguishes absent from cleared, so a missing title has
    // to arrive as a value the form can render as empty.
    directory.users.set('bare@company.com', {
      primaryEmail: 'bare@company.com',
      name: { givenName: 'Bare', familyName: 'Account', fullName: 'Bare Account' },
      orgUnitPath: '/',
    });

    const body = (await (await get('/lookup/users/bare@company.com')).json()) as Record<string, unknown>;

    expect(body.title).toBeNull();
    expect(body.department).toBeNull();
    expect(body.managerEmail).toBeNull();
  });
});

describe('AC-3: the group and org-unit pickers list what exists', () => {
  it('lists domain groups', async () => {
    const body = (await (await get('/lookup/groups')).json()) as { groups: { email: string }[] };

    expect(body.groups.map((g) => g.email)).toEqual([
      'engineering@company.com',
      'platform@company.com',
    ]);
  });

  it('lists org unit paths', async () => {
    const body = (await (await get('/lookup/org-units')).json()) as {
      orgUnits: { orgUnitPath: string }[];
    };

    expect(body.orgUnits.map((o) => o.orgUnitPath)).toEqual(['/Engineering', '/Sales']);
  });
});

describe('AC-4: every lookup route is read-only', () => {
  it('reaches no mutating Directory method from any route', async () => {
    // The probe throws on every mutation it exposes, so this drives the whole
    // surface and asserts nothing threw. An added route that wrote would fail
    // here without anyone having to remember to extend the test.
    for (const path of [
      '/lookup/users?q=ada',
      '/lookup/users/ada.lovelace@company.com',
      '/lookup/groups',
      '/lookup/org-units',
    ]) {
      expect((await get(path)).status).toBe(200);
    }

    expect(directory.calls.every((c) => /^(searchUsers|getUser|listMemberships|listGroups|listOrgUnits)/.test(c))).toBe(true);
  });

  it('binds no write verb on the lookup router', async () => {
    // A GET-only surface. POST/PUT/PATCH/DELETE fall through to the 404 handler
    // rather than reaching anything.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/lookup/users`, {
        method,
        headers: { authorization: 'Bearer any-token', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).not.toBe(200);
    }
  });
});

describe('AC-5 and AC-6: each identity is confined to its own route class', () => {
  it('rejects a /lookup call with no OIDC token before any handler runs', async () => {
    const res = await fetch(`${base}/lookup/groups`);

    expect(res.status).toBe(401);
    // Before any handler: the Directory was never touched.
    expect(directory.calls).toEqual([]);
  });

  it('rejects a /tasks call bearing the API service identity', async () => {
    // The token verifier admits API_SA; the /tasks mount expects the queue.
    const res = await fetch(`${base}/tasks/execute-step`, {
      method: 'POST',
      headers: { authorization: 'Bearer any-token', 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(401);
  });

  it('admits the API service identity on /lookup', async () => {
    // The control. Without it the two rejections above would also hold for a
    // middleware that refused everything.
    expect((await get('/lookup/groups')).status).toBe(200);
  });
});

describe('AC-7: lookups inherit the shared client, classification included', () => {
  it('surfaces a permission failure as 403 rather than a generic error', async () => {
    directory.failWith = new WorkspaceError('Not Authorized', 'permission', 403, 'groups.list');

    expect((await get('/lookup/groups')).status).toBe(403);
  });

  it('surfaces an upstream fault as 502 rather than pretending it succeeded', async () => {
    directory.failWith = new WorkspaceError('backend error', 'retryable', 503, 'groups.list');

    expect((await get('/lookup/groups')).status).toBe(502);
  });

  it('constructs no Directory client of its own', async () => {
    // AC-7's real content: the router receives a client, it does not build one.
    // Enforced repository-wide by the delegation scan; asserted here as the
    // module's own contract.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./lookup.ts', import.meta.url), 'utf8'),
    );

    expect(source).not.toMatch(/new DirectoryClient\(/);
    expect(source).not.toMatch(/new GoogleAuth\(/);
  });
});

describe('AC-8: an absent user or group is 404, not an empty success', () => {
  it('returns 404 for a user that does not exist', async () => {
    const res = await get('/lookup/users/nobody@company.com');

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'not_found' });
  });

  it('does not fetch memberships for a user it could not find', async () => {
    await get('/lookup/users/nobody@company.com');

    expect(directory.calls.some((c) => c.startsWith('listMemberships'))).toBe(false);
  });
});

/**
 * AC-9: a lookup result is a snapshot, never an authority.
 *
 * The failure this guards against is subtle and would not show up in any test
 * above: a diff computed from what the picker showed rather than from what the
 * domain currently holds. The operator sees a title of "Staff Engineer", someone
 * else changes it while the form is open, and the request is submitted. If the
 * step trusted the lookup, it would compute a change against a value that is no
 * longer there and silently overwrite the newer one.
 *
 * So this performs a real lookup, changes the domain underneath it, then runs
 * the step and asserts the diff was computed against the NEWER state.
 */
describe('AC-9: the executing step re-reads live state after a lookup', () => {
  it('computes the diff from current state, not from what the lookup returned', async () => {
    Object.assign(process.env, {
      GCP_PROJECT_ID: 'company-project',
      TASKS_QUEUE: 'lifecycle-steps',
      TASKS_LOCATION: 'us-central1',
      WORKER_BASE_URL: AUDIENCE,
      QUEUE_INVOKER_SA: QUEUE_SA,
      API_SERVICE_SA: API_SA,
      SMTP_SENDER: 'noreply@company.com',
      SMTP_CREDENTIAL_SECRET: 'projects/1/secrets/smtp',
      CREDENTIAL_KEY_SECRET: 'projects/1/secrets/credkey',
      CONSOLE_BASE_URL: 'https://console.example.com',
    });
    const { resolveHandler } = await import('../steps/handler.js');
    await import('../phases/update.js');

    // 1. The operator's picker reads the user and sees the title of the moment.
    const looked = (await (await get('/lookup/users/ada.lovelace@company.com')).json()) as {
      title: string;
    };
    expect(looked.title).toBe('Staff Engineer');

    // 2. Someone else changes it while the form is open.
    directory.users.set('ada.lovelace@company.com', {
      ...(directory.users.get('ada.lovelace@company.com') as Record<string, unknown>),
      organizations: [{ title: 'Principal Engineer', department: 'Platform', primary: true }],
    });

    // 3. The step runs. It must observe the newer value.
    let recorded: { attributes: { field: string; before: unknown; after: unknown }[] } | null = null;
    const ctx = {
      request: {
        requestId: 'req-1',
        requestedBy: 'operator@company.com',
        payload: { primaryEmail: 'ada.lovelace@company.com', title: 'Distinguished Engineer' },
      },
      step: { stepId: 'step-1' },
      directory: {
        getUser: (email: string) => directory.getUser(email),
        hasMember: async () => false,
      },
      store: {
        recordComputedDiff: async (params: { diff: typeof recorded }) => {
          recorded = params.diff;
        },
      },
    };

    await resolveHandler('compute-update-diff').execute(ctx as never);

    const title = recorded!.attributes.find((a) => a.field === 'title')!;
    // 'Principal Engineer' is what the domain held at execution time. The
    // lookup's 'Staff Engineer' must appear nowhere in the change set.
    expect(title.before).toBe('Principal Engineer');
    expect(title.after).toBe('Distinguished Engineer');
  });
});
