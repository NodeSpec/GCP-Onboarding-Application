import type { LifecycleStore, OperatorRole } from '@lifecycle/shared';
import type { RoleResolver } from './authz.js';
import type { OperatorIdentity } from './middleware/iapAuth.js';

/**
 * Resolves an operator's roles from the role binding store (REQ-012).
 *
 * IAP proves who the caller is; this decides what they may do. The two are
 * deliberately separate: a verified identity with no binding is authenticated
 * and authorized for nothing, which is the default an internal admin tool
 * should have.
 *
 * Roles are the UNION of the identity's own binding and the bindings of every
 * group it belongs to, so a group binding grants exactly what the equivalent
 * individual binding would (REQ-012 AC-7). Nothing about the resulting role set
 * records where it came from, because the enforcement point should not care.
 *
 * Replaces the earlier provisional resolver, which granted 'requester' to
 * everyone and therefore made the approve and reject routes unreachable.
 */

/**
 * Supplies the groups an operator belongs to.
 *
 * Group membership comes from the Workspace Directory API, which this service
 * does not call: the API service reaches Workspace only through the worker's
 * read-only lookup route (REQ-029), which is not built yet. Until it is, wire
 * this to `noGroupMemberships` and only individual bindings resolve. The
 * resolution logic below is the same either way.
 */
export interface GroupMembershipProvider {
  groupsFor(email: string): Promise<string[]>;
}

export const noGroupMemberships: GroupMembershipProvider = {
  async groupsFor(): Promise<string[]> {
    return [];
  },
};

export interface BindingResolverOptions {
  groups?: GroupMembershipProvider;
  /**
   * Emails that always hold 'admin', from configuration.
   *
   * Without this the store is unreachable: granting the first admin requires an
   * admin, and nobody has one on a fresh deployment. Deliberately config rather
   * than data, so changing it takes a deploy by whoever controls the
   * infrastructure rather than an API call.
   */
  bootstrapAdmins?: readonly string[];
  /**
   * How long a resolved role set may be reused, in milliseconds.
   *
   * DEFAULT 0, meaning no caching. A cache here trades revocation latency for
   * read volume: with a 60s TTL, an operator whose approver role was just
   * revoked can still approve for up to a minute. For an internal console the
   * read volume is not the problem worth solving, so caching is opt-in and the
   * cost is stated where it is switched on.
   */
  cacheTtlMs?: number;
}

interface CacheEntry {
  roles: OperatorRole[];
  expiresAt: number;
}

export class BindingRoleResolver implements RoleResolver {
  private readonly groups: GroupMembershipProvider;
  private readonly bootstrapAdmins: ReadonlySet<string>;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly store: LifecycleStore,
    options: BindingResolverOptions = {},
  ) {
    this.groups = options.groups ?? noGroupMemberships;
    this.bootstrapAdmins = new Set(
      (options.bootstrapAdmins ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean),
    );
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
  }

  async rolesFor(identity: OperatorIdentity): Promise<OperatorRole[]> {
    const email = identity.email.toLowerCase();

    const cached = this.cache.get(email);
    if (cached && cached.expiresAt > Date.now()) return cached.roles;

    const roles = new Set<OperatorRole>();

    if (this.bootstrapAdmins.has(email)) roles.add('admin');

    const own = await this.store.getRoleBinding(email);
    // A 'group' binding whose subject happens to match a person's address is
    // not a binding for that person. Checking the kind keeps a group address
    // from granting itself roles if one is ever used to sign in.
    if (own && own.kind === 'user') for (const role of own.roles) roles.add(role);

    // A failure to read group membership must not silently downgrade someone to
    // their individual roles: that would turn a Directory outage into a partial
    // authorization decision that looks like a deliberate one. Let it throw; the
    // route returns 500 and the operator retries.
    const memberships = await this.groups.groupsFor(email);

    const bindings = await Promise.all(
      [...new Set(memberships.map((g) => g.toLowerCase()))].map((group) =>
        this.store.getRoleBinding(group).then((binding) => ({ group, binding })),
      ),
    );

    for (const { binding } of bindings) {
      if (binding && binding.kind === 'group') for (const role of binding.roles) roles.add(role);
    }

    const resolved = [...roles].sort();
    if (this.cacheTtlMs > 0) {
      this.cache.set(email, { roles: resolved, expiresAt: Date.now() + this.cacheTtlMs });
    }
    return resolved;
  }

  /** Drops cached decisions. Called after a binding change so it takes hold at once. */
  invalidate(email?: string): void {
    if (email === undefined) this.cache.clear();
    else this.cache.delete(email.toLowerCase());
  }
}
