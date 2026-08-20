import { Router } from 'express';
import { requireRole, type RoleResolver } from '../authz.js';
import { guarded } from '../middleware/asyncGuard.js';
import { LookupUnavailable, WorkerLookupClient } from '../lookup/workerClient.js';

/**
 * The console's directory pickers, proxied to the worker (REQ-029).
 *
 * These are the operator-facing half. The worker owns the Workspace credential
 * and serves the actual lookup; this router is what the browser can reach,
 * which means it sits behind IAP like every other operator route and carries a
 * role check of its own.
 *
 * Requester is the floor. Directory contents are not public within a tenant —
 * who exists, which groups they are in and what the org tree looks like is
 * exactly the reconnaissance an attacker wants — so an authenticated identity
 * with no binding gets nothing here, the same as everywhere else (REQ-012 AC-2).
 *
 * Read-only, and deliberately thin: no filtering, no reshaping, no caching of
 * directory contents in this service. Anything this router decided for itself
 * would be a second answer to a question the worker already answers.
 */

export interface LookupRouteDeps {
  client?: WorkerLookupClient;
  resolver?: RoleResolver;
}

interface UserSearchResult {
  users: { primaryEmail: string; fullName: string; orgUnitPath: string; suspended: boolean }[];
  nextPageToken?: string;
}

export function lookupRoutes(deps: LookupRouteDeps = {}): Router {
  const router = Router();
  const authz = { ...(deps.resolver === undefined ? {} : { resolver: deps.resolver }) };
  const client = deps.client ?? new WorkerLookupClient();

  /** Maps a worker failure onto a status the console can act on. */
  function relay(err: unknown, res: import('express').Response): void {
    if (err instanceof LookupUnavailable) {
      // 404 and 403 mean something specific to a picker and are passed through;
      // anything else is reported as an upstream fault rather than as the
      // operator's mistake.
      const status = err.status === 404 || err.status === 403 ? err.status : 502;
      res.status(status).json({ error: status === 404 ? 'not_found' : 'lookup_unavailable' });
      return;
    }
    res.status(502).json({ error: 'lookup_unavailable' });
  }

  // Guarded like every other async handler in this service, even though each
  // one's try/catch already relays every failure: uniformity is what keeps the
  // next handler from being the one that crashes the process
  // (see middleware/asyncGuard.ts).
  router.get('/users', requireRole('requester', authz), guarded(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length === 0) {
      res.status(400).json({ error: 'q is required' });
      return;
    }

    try {
      res.status(200).json(
        await client.get<UserSearchResult>('/users', {
          q,
          limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
          pageToken: typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined,
        }),
      );
    } catch (err) {
      relay(err, res);
    }
  }));

  router.get('/users/:primaryEmail', requireRole('requester', authz), guarded(async (req, res) => {
    try {
      res
        .status(200)
        .json(await client.get(`/users/${encodeURIComponent(String(req.params.primaryEmail))}`));
    } catch (err) {
      relay(err, res);
    }
  }));

  router.get('/groups', requireRole('requester', authz), guarded(async (req, res) => {
    try {
      res.status(200).json(
        await client.get('/groups', {
          limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
        }),
      );
    } catch (err) {
      relay(err, res);
    }
  }));

  router.get('/org-units', requireRole('requester', authz), guarded(async (_req, res) => {
    try {
      res.status(200).json(await client.get('/org-units'));
    } catch (err) {
      relay(err, res);
    }
  }));

  return router;
}
