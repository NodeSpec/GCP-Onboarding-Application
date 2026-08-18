import type { GroupMembershipProvider } from '../roles.js';
import { LookupUnavailable, WorkerLookupClient } from './workerClient.js';

/**
 * Group membership for role resolution, read through the worker (REQ-012 AC-7).
 *
 * This closes the gap the resolver was built around: `BindingRoleResolver`
 * always knew how to union a group binding into an operator's roles, but the
 * entry point supplied no membership source, so a `group` binding resolved
 * correctly in tests and granted nothing in a deployment. The membership source
 * is REQ-029's lookup surface, and this is the adapter between them.
 *
 * The API service still holds no Workspace credential and never will. It asks
 * the worker, which holds the only admin role, over the same read-only route
 * the console's pickers use.
 *
 * CACHING LIVES HERE, NOT IN THE RESOLVER, and that placement is the point.
 *
 * Roles are resolved on every authorized request. Without a cache each one
 * would cost a Directory API round trip, which is both slow in front of an
 * operator and a real draw on the same quota the step queue is deliberately
 * throttled to protect (REQ-021 AC-2).
 *
 * Caching the resolved ROLE SET would have been the easy place to put it, and
 * it would have been wrong: role bindings are edited through this application,
 * which invalidates the resolver's cache on the exact subject that changed, and
 * a role-set cache would sit in front of that and make a revocation take effect
 * whenever the entry happened to expire. Caching memberships instead leaves
 * binding revocation exact and makes only Workspace group membership stale.
 *
 * The residual cost, stated: removing somebody from a Workspace group that
 * carries a role does not revoke it until this entry expires. That window is
 * `ttlMs`. Removing their individual binding, or the group's binding, still
 * takes effect immediately.
 */

interface UserDetail {
  primaryEmail: string;
  groups: string[];
}

export interface WorkerGroupMembershipOptions {
  client?: WorkerLookupClient;
  /** How long a membership list may be reused. Zero disables caching. */
  ttlMs?: number;
  now?: () => number;
}

/** Five minutes. Long enough to keep the Directory API out of the hot path. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface Entry {
  groups: string[];
  expiresAt: number;
}

export class WorkerGroupMemberships implements GroupMembershipProvider {
  private readonly client: WorkerLookupClient;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  /** In-flight lookups, so a burst for one operator makes one call. */
  private readonly inFlight = new Map<string, Promise<string[]>>();

  constructor(options: WorkerGroupMembershipOptions = {}) {
    this.client = options.client ?? new WorkerLookupClient();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async groupsFor(email: string): Promise<string[]> {
    const key = email.trim().toLowerCase();
    if (key.length === 0) return [];

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.groups;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.fetch(key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async fetch(email: string): Promise<string[]> {
    let groups: string[];

    try {
      const detail = await this.client.get<UserDetail>(`/users/${encodeURIComponent(email)}`);
      groups = Array.isArray(detail.groups) ? detail.groups : [];
    } catch (err) {
      // A 404 is an ANSWER, not a failure: this identity is not a Workspace
      // user, so it belongs to no group in this domain. A bootstrap admin from
      // outside the tenant is the realistic case, and treating it as an error
      // would make them unable to sign in at all.
      if (err instanceof LookupUnavailable && err.status === 404) {
        groups = [];
      } else {
        // Everything else propagates. Returning an empty list here would
        // silently downgrade an operator to their individual roles, turning a
        // Directory outage into a partial authorization decision that looks
        // exactly like a deliberate one. The route returns 500 and the operator
        // retries, which is the honest outcome.
        throw err;
      }
    }

    if (this.ttlMs > 0) {
      this.cache.set(email, { groups, expiresAt: this.now() + this.ttlMs });
    }
    return groups;
  }

  /** Drops a cached membership list. Used when a role binding changes. */
  invalidate(email: string): void {
    this.cache.delete(email.trim().toLowerCase());
  }

  /** Drops every cached membership list. */
  invalidateAll(): void {
    this.cache.clear();
  }
}
