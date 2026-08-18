import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OperatorRole } from '@lifecycle/shared';
import type { OperatorIdentity } from '../middleware/iapAuth.js';
import { LookupUnavailable, WorkerLookupClient } from '../lookup/workerClient.js';
import { lookupRoutes } from './lookup.js';

/**
 * The operator-facing half of REQ-029, plus the identity-hygiene claim that
 * makes the proxy design worth its cost.
 *
 * The point of routing pickers through the worker is that the API service never
 * holds a Workspace credential. That is asserted repository-wide by the
 * delegation scan; what is asserted here is the behaviour that would tempt
 * someone to break it — the proxy works, passes statuses through, and mints its
 * token from the runtime identity rather than from anything it stores.
 */

const OPERATOR = 'operator@company.com';

let identity: OperatorIdentity = { email: OPERATOR, subject: 'sub-1' };
let roles: OperatorRole[] = ['requester'];

/** Stands in for the worker. Records what it was asked and with what token. */
class FakeWorker {
  requests: { url: string; authorization: string | null }[] = [];
  respondWith: { status: number; body: unknown } = { status: 200, body: { groups: [] } };
  throwWith: unknown = null;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.throwWith) throw this.throwWith;
    this.requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return new Response(JSON.stringify(this.respondWith.body), {
      status: this.respondWith.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  reset() {
    this.requests = [];
    this.respondWith = { status: 200, body: { groups: [] } };
    this.throwWith = null;
  }
}

const worker = new FakeWorker();
let tokensMinted = 0;

/** A token that expires an hour out, so the cache is exercised honestly. */
function tokenExpiringIn(seconds: number): string {
  const claims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))
    .toString('base64url');
  return `header.${claims}.signature`;
}

const client = new WorkerLookupClient({
  baseUrl: 'https://lifecycle-worker.example.com',
  fetchImpl: (input, init) => worker.fetch(input, init),
  tokenSource: async () => {
    tokensMinted += 1;
    return tokenExpiringIn(3600);
  },
});

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
    '/api/lookup',
    lookupRoutes({ client, resolver: { async rolesFor() { return roles; } } }),
  );

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  identity = { email: OPERATOR, subject: 'sub-1' };
  roles = ['requester'];
  worker.reset();
});

const get = (path: string) => fetch(`${base}${path}`);

describe('the console reaches the pickers through the API', () => {
  it('proxies a user search to the worker and returns its body', async () => {
    worker.respondWith = {
      status: 200,
      body: { users: [{ primaryEmail: 'ada.lovelace@company.com' }] },
    };

    const res = await get('/api/lookup/users?q=ada');
    const body = (await res.json()) as { users: { primaryEmail: string }[] };

    expect(res.status).toBe(200);
    expect(body.users[0]!.primaryEmail).toBe('ada.lovelace@company.com');
    expect(worker.requests[0]!.url).toBe(
      'https://lifecycle-worker.example.com/lookup/users?q=ada',
    );
  });

  it('forwards pagination rather than answering it locally', async () => {
    await get('/api/lookup/users?q=ada&limit=50&pageToken=page-1');

    const url = new URL(worker.requests[0]!.url);
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('pageToken')).toBe('page-1');
  });

  it('proxies the group and org-unit pickers', async () => {
    await get('/api/lookup/groups');
    await get('/api/lookup/org-units');

    expect(worker.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/lookup/groups',
      '/lookup/org-units',
    ]);
  });

  it('escapes the address in a single-user lookup', async () => {
    // A '+' in an address is legal and would otherwise decode as a space.
    await get(`/api/lookup/users/${encodeURIComponent('ada+test@company.com')}`);

    expect(worker.requests[0]!.url).toContain('ada%2Btest%40company.com');
  });

  it('requires a query rather than proxying a request to list everyone', async () => {
    const res = await get('/api/lookup/users?q=');

    expect(res.status).toBe(400);
    expect(worker.requests).toHaveLength(0);
  });
});

describe('the pickers are authorized like every other operator route', () => {
  it('refuses an identity with no role binding', async () => {
    // Directory contents are reconnaissance. An authenticated identity with no
    // binding gets nothing here, the same as everywhere else.
    roles = [];

    const res = await get('/api/lookup/users?q=ada');

    expect(res.status).toBe(403);
    expect(worker.requests).toHaveLength(0);
  });

  it('admits a requester', async () => {
    roles = ['requester'];

    expect((await get('/api/lookup/groups')).status).toBe(200);
  });

  it('refuses every lookup route without a binding, not just the search', async () => {
    roles = [];

    for (const path of ['/api/lookup/users?q=a', '/api/lookup/groups', '/api/lookup/org-units']) {
      expect((await get(path)).status).toBe(403);
    }
  });
});

describe('worker failures are reported as what they are', () => {
  it('passes a 404 through, so a picker can say the user does not exist', async () => {
    worker.respondWith = { status: 404, body: { error: 'not_found' } };

    const res = await get('/api/lookup/users/nobody@company.com');

    expect(res.status).toBe(404);
  });

  it('passes a 403 through, which means the admin role is missing upstream', async () => {
    worker.respondWith = { status: 403, body: { error: 'lookup_failed' } };

    expect((await get('/api/lookup/groups')).status).toBe(403);
  });

  it('reports an unreachable worker as 502 rather than as the operator\'s mistake', async () => {
    worker.throwWith = new Error('ECONNREFUSED');

    const res = await get('/api/lookup/groups');

    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'lookup_unavailable' });
  });

  it('does not leak the upstream error text to the operator', async () => {
    worker.throwWith = new Error('connect ECONNREFUSED 10.1.2.3:8080');

    const body = await (await get('/api/lookup/groups')).text();

    expect(body).not.toContain('10.1.2.3');
  });
});

describe('the token comes from the runtime identity and is reused', () => {
  it('presents a bearer token to the worker', async () => {
    await get('/api/lookup/groups');

    expect(worker.requests[0]!.authorization).toMatch(/^Bearer .+/);
  });

  it('mints one token for many lookups rather than one per keystroke', async () => {
    const before = tokensMinted;

    for (let i = 0; i < 5; i += 1) await get('/api/lookup/users?q=ad');

    // A metadata round trip in front of every character an operator types would
    // make the picker unusable.
    expect(tokensMinted - before).toBeLessThanOrEqual(1);
  });

  it('refreshes a token that is close to expiry', async () => {
    let minted = 0;
    const expiring = new WorkerLookupClient({
      baseUrl: 'https://lifecycle-worker.example.com',
      fetchImpl: (input, init) => worker.fetch(input, init),
      tokenSource: async () => {
        minted += 1;
        // Inside the refresh margin, so it is never reused.
        return tokenExpiringIn(60);
      },
    });

    await expiring.get('/groups');
    await expiring.get('/groups');

    expect(minted).toBe(2);
  });

  it('treats an undecodable token as spent rather than sending it forever', async () => {
    let minted = 0;
    const opaque = new WorkerLookupClient({
      baseUrl: 'https://lifecycle-worker.example.com',
      fetchImpl: (input, init) => worker.fetch(input, init),
      tokenSource: async () => {
        minted += 1;
        return 'not-a-jwt';
      },
    });

    await opaque.get('/groups');
    await opaque.get('/groups');

    expect(minted).toBe(2);
  });
});

describe('the client surfaces a typed failure rather than a bare throw', () => {
  it('raises LookupUnavailable carrying the upstream status', async () => {
    worker.respondWith = { status: 404, body: {} };

    const err = await client.get('/users/nobody@company.com').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LookupUnavailable);
    expect((err as LookupUnavailable).status).toBe(404);
  });
});
