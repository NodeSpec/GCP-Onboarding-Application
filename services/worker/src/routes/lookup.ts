import { Router } from 'express';
import type { DirectoryClient } from '../workspace/directoryClient.js';
import { WorkspaceError } from '../workspace/directoryClient.js';
import { logger } from '../logging.js';

/**
 * Read-only directory lookup, for the operator console's pickers (REQ-029).
 *
 * Phases 3 and 4 act on an existing user and phase 1 assigns groups and an org
 * unit, so an operator has to be able to FIND those before submitting. Without
 * this every target is free text validated only when the worker executes, which
 * turns a typo into a request that fails minutes later.
 *
 * These routes live on the worker rather than the API service because the
 * worker holds the only Workspace admin role. Routing lookups through it keeps
 * REQ-014's identity separation exactly as written and keeps the shared
 * Directory client the single choke point for retry and error classification
 * (REQ-013 AC-6, REQ-029 AC-7). The API service calls in with an OIDC token and
 * never touches the Directory API itself.
 *
 * Every handler here READS. The router is mounted behind
 * requireCaller('api-service'), which is what stops the Cloud Tasks identity
 * reaching it and vice versa (REQ-029 AC-5, AC-6); this module assumes that
 * mounting and does not re-check the caller.
 *
 * Nothing returned here is authoritative. A picker result is already stale by
 * the time the operator submits, so the executing step still performs its own
 * pre-mutation read (REQ-029 AC-9). These results pre-fill forms, they do not
 * decide anything.
 */

export interface LookupDeps {
  directory: Pick<
    DirectoryClient,
    'searchUsers' | 'getUser' | 'listMemberships' | 'listGroups' | 'listOrgUnits'
  >;
}

/** Caps the page size so a caller cannot ask for the whole domain in one go. */
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

function pageSize(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE;
  return Math.min(parsed, MAX_PAGE);
}

/**
 * Translates a Workspace failure into a status. The classification already
 * happened in the shared client; this only maps it, so a lookup reports a
 * permission problem as 403 rather than flattening everything to 500.
 */
function statusFor(err: unknown): number {
  if (err instanceof WorkspaceError) {
    if (err.errorClass === 'permission') return 403;
    if (err.errorClass === 'not_found') return 404;
    if (err.errorClass === 'terminal') return 400;
  }
  return 502;
}

function fail(operation: string, err: unknown, res: import('express').Response): void {
  const status = statusFor(err);
  logger.warn(
    { operation, status, err: err instanceof Error ? err.message : 'unknown' },
    'directory lookup failed',
  );
  res.status(status).json({ error: 'lookup_failed', operation });
}

export function lookupRoutes(deps: LookupDeps): Router {
  const router = Router();

  /**
   * AC-1: prefix search for the user picker, paginated.
   *
   * The query is passed to the Directory API's own prefix syntax rather than
   * fetched-then-filtered, so the page size means what it says and the domain
   * is never enumerated into this process.
   */
  router.get('/users', async (req, res) => {
    const query = String(req.query.q ?? '').trim();
    if (query.length === 0) {
      res.status(400).json({ error: 'q is required' });
      return;
    }

    try {
      const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined;
      const result = await deps.directory.searchUsers(
        `email:${query}*`,
        pageSize(req.query.limit),
        pageToken,
      );
      res.status(200).json(result);
    } catch (err) {
      fail('users.search', err, res);
    }
  });

  /**
   * AC-2: one user with the attributes and memberships an update form pre-fills
   * from. Memberships are fetched alongside because a form that showed
   * attributes without groups would send the operator to a second screen to
   * answer the same question.
   *
   * AC-8: absent means 404, never an empty success. A picker that rendered a
   * blank row for a deleted account would let an operator select nothing and
   * submit it.
   */
  router.get('/users/:primaryEmail', async (req, res) => {
    const primaryEmail = String(req.params.primaryEmail);

    try {
      const user = await deps.directory.getUser(primaryEmail);
      if (!user) {
        res.status(404).json({ error: 'not_found', primaryEmail });
        return;
      }

      const groups = await deps.directory.listMemberships(primaryEmail);
      const organization = user.organizations?.[0] as
        | { title?: string; department?: string }
        | undefined;
      const relations = (user.relations ?? []) as { value?: string; type?: string }[];
      const manager = relations.find((relation) => relation.type === 'manager');

      res.status(200).json({
        primaryEmail: user.primaryEmail ?? primaryEmail,
        givenName: user.name?.givenName ?? '',
        familyName: user.name?.familyName ?? '',
        fullName: user.name?.fullName ?? '',
        orgUnitPath: user.orgUnitPath ?? '/',
        suspended: user.suspended === true,
        title: organization?.title ?? null,
        department: organization?.department ?? null,
        managerEmail: manager?.value ?? null,
        groups,
      });
    } catch (err) {
      fail('users.get', err, res);
    }
  });

  /** AC-3: the group picker. */
  router.get('/groups', async (req, res) => {
    try {
      res.status(200).json({ groups: await deps.directory.listGroups(pageSize(req.query.limit)) });
    } catch (err) {
      fail('groups.list', err, res);
    }
  });

  /** AC-3: the org-unit picker. */
  router.get('/org-units', async (_req, res) => {
    try {
      res.status(200).json({ orgUnits: await deps.directory.listOrgUnits() });
    } catch (err) {
      fail('orgunits.list', err, res);
    }
  });

  return router;
}
