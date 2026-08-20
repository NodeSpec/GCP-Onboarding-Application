import { startTestServer } from '@lifecycle/test-support';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireRole, type RoleResolver } from '../authz.js';
import { guarded } from './asyncGuard.js';
import { createIapAuth } from './iapAuth.js';

/**
 * The crash that motivated this module, reproduced and refused.
 *
 * Express 4 drops a rejected promise from an async handler on the floor; Node
 * kills the process for it, and Cloud Run answers "Service Unavailable" in
 * plain text. Found live three times, always during a deploy, always wearing
 * an authentication costume: the first rejection came from role resolution
 * calling a worker that was still cold.
 *
 * These tests assert the property that ends that class of outage: a rejection
 * anywhere behind guarded() becomes a JSON 500 through the error middleware,
 * and the server is still alive to answer the next request.
 */

/** Flips between failing and working, like a worker across a cold start. */
let lookupBroken = true;

const flakyResolver: RoleResolver = {
  async rolesFor() {
    if (lookupBroken) throw new Error('lookup unavailable: worker is cold');
    return ['requester', 'approver', 'admin'];
  },
};

const app = express();
app.use(express.json());
app.use(
  createIapAuth({
    audience: '/projects/123456/global/backendServices/789',
    auditDenied: async () => {},
    bypassIdentity: { email: 'operator@company.com', subject: 'test-subject' },
  }),
);

// The exact shape of /api/me in the composition root: an inline async handler
// that awaits role resolution.
app.get(
  '/api/me',
  guarded(async (req, res) => {
    const identity = req.identity!;
    res.status(200).json({ email: identity.email, roles: await flakyResolver.rolesFor(identity) });
  }),
);

// A guarded route behind requireRole, which awaits the same resolver.
app.get('/api/guarded', requireRole('requester', { resolver: flakyResolver }), (_req, res) => {
  res.status(200).json({ reached: true });
});

// The error middleware from the composition root: logs, answers JSON, no stack.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: 'internal_error' });
});

let server: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

describe('a rejection behind guarded() is a 500, not a dead process', () => {
  it('answers JSON 500 when the handler itself rejects', async () => {
    lookupBroken = true;

    const res = await fetch(`${server.base}/api/me`);

    expect(res.status).toBe(500);
    // JSON, specifically. The live failure was the console choking on a
    // plain-text "Service Unavailable" body where JSON was promised.
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });

  it('answers JSON 500 when role resolution inside requireRole rejects', async () => {
    lookupBroken = true;

    const res = await fetch(`${server.base}/api/guarded`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });

  it('serves the very next request once the dependency recovers', async () => {
    // The property the process-death failure mode destroyed: recovery needs a
    // reload, not a new instance.
    lookupBroken = true;
    await fetch(`${server.base}/api/me`);

    lookupBroken = false;
    const me = await fetch(`${server.base}/api/me`);
    const guardedRoute = await fetch(`${server.base}/api/guarded`);

    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe('operator@company.com');
    expect(guardedRoute.status).toBe(200);
  });

  it('leaves a synchronous handler exactly as it was', async () => {
    // guarded() must not swallow a normal response.
    lookupBroken = false;
    const res = await fetch(`${server.base}/api/guarded`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });
});
