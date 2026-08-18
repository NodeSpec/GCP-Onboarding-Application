import { startTestServer } from '@lifecycle/test-support';
import express, { type Router } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIapAuth } from './middleware/iapAuth.js';
import { adminRoutes } from './routes/admin.js';
import { lookupRoutes } from './routes/lookup.js';
import { requestRoutes } from './routes/requests.js';
import { roleBindingRoutes } from './routes/roleBindings.js';
import { ProtectedAccounts } from './protectedAccounts.js';

/**
 * TC-REQ-007-12: no unauthenticated route exists, ENUMERATED rather than
 * spot-checked.
 *
 * The criterion is specific about the method, and the reason is that a
 * spot-check proves nothing about the route somebody adds next month. This
 * builds the real routers, walks the resulting Express stack to discover every
 * path the application actually serves, and fires an unauthenticated request at
 * each one. A new route is covered the moment it is mounted, without anybody
 * remembering to add a case.
 *
 * The mounting order is the same as the composition root's: the health check
 * before iapAuth, everything else after it. That ordering is the control, so
 * reproducing it is the point rather than an incidental detail.
 *
 * No handler can run here. The dependencies below are deliberately hostile:
 * every one throws if touched, so a route that somehow got past the middleware
 * fails loudly instead of quietly returning a 200 from a fake.
 */

/** Anything that reaches a handler is a failure, so make it one. */
const hostile = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'then') return undefined;
      return () => {
        throw new Error(
          `a route handler ran without authentication and touched ${String(property)}`,
        );
      };
    },
  },
) as never;

interface RouteEntry {
  method: string;
  path: string;
}

/**
 * Walks an Express router stack and returns every mounted path.
 *
 * Reading `stack` is reaching into Express's internals, and that is accepted
 * deliberately: the alternative is a hand-maintained list of routes, which is
 * exactly the thing this test exists to avoid depending on.
 */
function enumerate(router: Router, prefix = ''): RouteEntry[] {
  const layers = (router as unknown as { stack?: unknown[] }).stack ?? [];
  const found: RouteEntry[] = [];

  for (const raw of layers) {
    const layer = raw as {
      route?: { path?: string; methods?: Record<string, boolean> };
      name?: string;
      handle?: Router;
      regexp?: RegExp;
    };

    if (layer.route?.path) {
      for (const [method, on] of Object.entries(layer.route.methods ?? {})) {
        if (on) found.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
      continue;
    }

    if (layer.name === 'router' && layer.handle) {
      found.push(...enumerate(layer.handle, prefix + mountPath(layer.regexp)));
    }
  }

  return found;
}

/** Recovers a mount prefix from the regexp Express compiled it into. */
function mountPath(regexp: RegExp | undefined): string {
  if (!regexp) return '';
  const source = regexp.source
    .replace('^\\/', '/')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/');
  return source === '/' || source.includes('(') ? '' : source;
}

/** Substitutes something concrete for each :param so the path is requestable. */
function concrete(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, 'probe-value');
}

const app = express();
app.use(express.json());

// Before the gate, deliberately. Cloud Run probes it without an assertion and
// it exposes nothing.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(
  createIapAuth({
    audience: '/projects/123456/global/backendServices/789',
    auditDenied: async () => {},
  }),
);

const mounted: { prefix: string; router: Router }[] = [
  {
    prefix: '/api/requests',
    router: requestRoutes({
      store: hostile,
      loadPolicy: hostile,
      dispatcher: hostile,
      resolver: hostile,
      credentials: hostile,
      onDenied: () => {},
      // Every key supplied explicitly, including the undefined ones. The class
      // reads by key presence, so an omitted key would fall through to
      // configuration and demand a full environment this test has no use for.
      protectedAccounts: new ProtectedAccounts({
        configured: [],
        sender: undefined,
        returnPathGroup: undefined,
      }),
    }),
  },
  { prefix: '/api/role-bindings', router: roleBindingRoutes({ store: hostile, resolver: hostile }) },
  { prefix: '/api/admin', router: adminRoutes({ store: hostile, dispatcher: hostile, resolver: hostile }) },
  { prefix: '/api/lookup', router: lookupRoutes({ resolver: hostile, client: hostile }) },
];

for (const { prefix, router } of mounted) app.use(prefix, router);

// Defined inline in the composition root rather than in a router, so it is
// mounted the same way here. It is the console's identity endpoint and it must
// not be reachable unauthenticated.
app.get('/api/me', () => {
  throw new Error('a route handler ran without authentication and reached /api/me');
});

const ROUTES: RouteEntry[] = [
  ...mounted.flatMap(({ prefix, router }) => enumerate(router, prefix)),
  { method: 'GET', path: '/api/me' },
];

let server: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

describe('the enumeration actually found the route table', () => {
  // A test that iterates an empty list passes for the wrong reason. This is
  // the guard that makes the coverage claim mean something.
  it('discovers a substantial number of routes', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it('covers every mounted router, not just the first', () => {
    const prefixes = new Set(ROUTES.map((r) => r.path.split('/').slice(0, 3).join('/')));
    for (const expected of ['/api/requests', '/api/role-bindings', '/api/admin', '/api/lookup']) {
      expect(prefixes, `no routes discovered under ${expected}`).toContain(expected);
    }
  });

  it('includes the identity endpoint the console depends on', () => {
    expect(ROUTES.map((r) => r.path)).toContain('/api/me');
  });

  it('covers both reads and writes', () => {
    const methods = new Set(ROUTES.map((r) => r.method));
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });
});

describe('AC-12: every route in the table rejects an unauthenticated request', () => {
  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s is rejected',
    async (_label, route) => {
      const res = await fetch(`${server.base}${concrete(route.path)}`, {
        method: route.method,
        ...(route.method === 'GET' || route.method === 'HEAD'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      });

      // 401 from the middleware, before any handler. A 403 would mean the
      // request reached authorization, which means it got past authentication.
      expect(res.status, `${route.method} ${route.path} answered ${res.status}`).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    },
  );

  it('rejects a path that does not exist, rather than 404ing before the gate', async () => {
    // A 404 here would prove the router was reached without an assertion. The
    // gate has to answer first, whatever the path.
    const res = await fetch(`${server.base}/api/there-is-no-such-route`);
    expect(res.status).toBe(401);
  });

  it('rejects a client-supplied identity header outright', async () => {
    // The header a caller would reach for if they assumed the application
    // trusted one. Identity comes from the verified assertion and nothing else.
    const res = await fetch(`${server.base}/api/me`, {
      headers: { 'x-goog-authenticated-user-email': 'admin@company.com' },
    });
    expect(res.status).toBe(401);
  });
});

describe('the health check stays reachable, and exposes nothing', () => {
  it('answers without an assertion', async () => {
    // Mounted before the gate on purpose: Cloud Run probes it without one.
    const res = await fetch(`${server.base}/healthz`);

    expect(res.status).toBe(200);
    // The whole body. A probe that leaked a version, a project id or a
    // configuration value would be an unauthenticated information source.
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
