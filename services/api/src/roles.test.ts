import type { LifecycleStore, OperatorRole, RoleBinding } from '@lifecycle/shared';
import { describe, expect, it } from 'vitest';
import { BindingRoleResolver, noGroupMemberships, type GroupMembershipProvider } from './roles.js';
import type { OperatorIdentity } from './middleware/iapAuth.js';

/**
 * TC-REQ-012-2 and TC-REQ-012-7: what an identity may do, derived from bindings.
 *
 * The store is faked here on purpose. What is under test is the RESOLUTION
 * rule - no binding means nothing, a group binding grants what the equivalent
 * individual binding would - and that rule is pure. The store's own behaviour,
 * including the audited write path, is proven against the emulator elsewhere.
 */

interface Fixture {
  bindings?: Record<string, RoleBinding>;
  groups?: Record<string, string[]>;
  bootstrapAdmins?: string[];
  cacheTtlMs?: number;
}

function binding(kind: 'user' | 'group', roles: OperatorRole[]): RoleBinding {
  return { kind, roles, updatedBy: 'admin@company.com', updatedAt: null as never };
}

let reads = 0;

function build(fixture: Fixture = {}) {
  const bindings = fixture.bindings ?? {};
  reads = 0;

  const store = {
    async getRoleBinding(subject: string) {
      reads += 1;
      return bindings[subject.toLowerCase()] ?? null;
    },
  } as unknown as LifecycleStore;

  const groups: GroupMembershipProvider = fixture.groups
    ? { async groupsFor(email) { return fixture.groups![email.toLowerCase()] ?? []; } }
    : noGroupMemberships;

  return new BindingRoleResolver(store, {
    groups,
    ...(fixture.bootstrapAdmins === undefined ? {} : { bootstrapAdmins: fixture.bootstrapAdmins }),
    ...(fixture.cacheTtlMs === undefined ? {} : { cacheTtlMs: fixture.cacheTtlMs }),
  });
}

const OPERATOR: OperatorIdentity = { email: 'ada@company.com', subject: 'sub-1' };

describe('AC-2: an identity with no binding is authorized for nothing', () => {
  it('resolves to an empty role set', async () => {
    expect(await build().rolesFor(OPERATOR)).toEqual([]);
  });

  it('grants nothing merely because the identity was verified', async () => {
    // The distinction the whole requirement rests on: IAP proved who they are,
    // which says nothing about what they may do.
    const roles = await build({ bindings: { 'someone.else@company.com': binding('user', ['admin']) } })
      .rolesFor(OPERATOR);

    expect(roles).toEqual([]);
  });
});

describe('individual bindings', () => {
  it('resolves the bound roles', async () => {
    const resolver = build({ bindings: { 'ada@company.com': binding('user', ['requester']) } });

    expect(await resolver.rolesFor(OPERATOR)).toEqual(['requester']);
  });

  it('matches the subject case-insensitively', async () => {
    const resolver = build({ bindings: { 'ada@company.com': binding('user', ['approver']) } });

    expect(await resolver.rolesFor({ email: 'Ada@Company.com', subject: 's' })).toEqual(['approver']);
  });

  it('ignores a group binding that happens to match the sign-in address', async () => {
    // A group address is not a person. If one is ever used to sign in it must
    // not inherit the roles bound to it as a group.
    const resolver = build({ bindings: { 'ada@company.com': binding('group', ['admin']) } });

    expect(await resolver.rolesFor(OPERATOR)).toEqual([]);
  });
});

describe('AC-7: a group binding grants what the equivalent individual binding would', () => {
  it('resolves roles inherited through a group', async () => {
    const resolver = build({
      bindings: { 'approvers@company.com': binding('group', ['approver']) },
      groups: { 'ada@company.com': ['approvers@company.com'] },
    });

    expect(await resolver.rolesFor(OPERATOR)).toEqual(['approver']);
  });

  it('produces the identical role set either way', async () => {
    const viaGroup = await build({
      bindings: { 'approvers@company.com': binding('group', ['approver', 'requester']) },
      groups: { 'ada@company.com': ['approvers@company.com'] },
    }).rolesFor(OPERATOR);

    const viaIndividual = await build({
      bindings: { 'ada@company.com': binding('user', ['approver', 'requester']) },
    }).rolesFor(OPERATOR);

    expect(viaGroup).toEqual(viaIndividual);
  });

  it('unions individual and group roles', async () => {
    const resolver = build({
      bindings: {
        'ada@company.com': binding('user', ['requester']),
        'approvers@company.com': binding('group', ['approver']),
      },
      groups: { 'ada@company.com': ['approvers@company.com'] },
    });

    expect(await resolver.rolesFor(OPERATOR)).toEqual(['approver', 'requester']);
  });

  it('unions across several groups and deduplicates', async () => {
    const resolver = build({
      bindings: {
        'approvers@company.com': binding('group', ['approver']),
        'operators@company.com': binding('group', ['approver', 'requester']),
      },
      groups: { 'ada@company.com': ['approvers@company.com', 'operators@company.com'] },
    });

    expect(await resolver.rolesFor(OPERATOR)).toEqual(['approver', 'requester']);
  });

  it('ignores a user binding reached through a group membership', async () => {
    const resolver = build({
      bindings: { 'bob@company.com': binding('user', ['admin']) },
      groups: { 'ada@company.com': ['bob@company.com'] },
    });

    expect(await resolver.rolesFor(OPERATOR)).toEqual([]);
  });

  it('resolves to nothing when a group has no binding', async () => {
    const resolver = build({ groups: { 'ada@company.com': ['unbound@company.com'] } });

    expect(await resolver.rolesFor(OPERATOR)).toEqual([]);
  });
});

describe('group lookup failures are not silently downgraded', () => {
  it('propagates rather than resolving to the individual roles alone', async () => {
    // A Directory outage must not quietly produce a smaller role set that looks
    // like a deliberate authorization decision.
    const store = {
      async getRoleBinding() { return binding('user', ['requester']); },
    } as unknown as LifecycleStore;

    const resolver = new BindingRoleResolver(store, {
      groups: { async groupsFor() { throw new Error('directory unavailable'); } },
    });

    await expect(resolver.rolesFor(OPERATOR)).rejects.toThrow('directory unavailable');
  });
});

describe('bootstrap admins', () => {
  it('holds admin with an empty store, which is the only way in', async () => {
    const resolver = build({ bootstrapAdmins: ['ada@company.com'] });

    expect(await resolver.rolesFor(OPERATOR)).toEqual(['admin']);
  });

  it('is matched case-insensitively and tolerates surrounding whitespace', async () => {
    const resolver = build({ bootstrapAdmins: ['  Ada@Company.com  '] });

    expect(await resolver.rolesFor(OPERATOR)).toEqual(['admin']);
  });

  it('grants nobody else anything', async () => {
    const resolver = build({ bootstrapAdmins: ['root@company.com'] });

    expect(await resolver.rolesFor(OPERATOR)).toEqual([]);
  });

  it('unions with whatever the store binds', async () => {
    const resolver = build({
      bindings: { 'ada@company.com': binding('user', ['requester']) },
      bootstrapAdmins: ['ada@company.com'],
    });

    expect(await resolver.rolesFor(OPERATOR)).toEqual(['admin', 'requester']);
  });

  it('treats an empty configured list as granting nothing', async () => {
    expect(await build({ bootstrapAdmins: [] }).rolesFor(OPERATOR)).toEqual([]);
  });
});

describe('caching is off by default', () => {
  it('reads the store on every call', async () => {
    const resolver = build({ bindings: { 'ada@company.com': binding('user', ['requester']) } });

    await resolver.rolesFor(OPERATOR);
    await resolver.rolesFor(OPERATOR);

    // Two calls, two reads: a revocation takes effect on the very next request.
    expect(reads).toBe(2);
  });

  it('serves a second call from cache when a TTL is configured', async () => {
    const resolver = build({
      bindings: { 'ada@company.com': binding('user', ['requester']) },
      cacheTtlMs: 60_000,
    });

    await resolver.rolesFor(OPERATOR);
    await resolver.rolesFor(OPERATOR);

    expect(reads).toBe(1);
  });

  it('re-reads after the cached decision is invalidated', async () => {
    const resolver = build({
      bindings: { 'ada@company.com': binding('user', ['requester']) },
      cacheTtlMs: 60_000,
    });

    await resolver.rolesFor(OPERATOR);
    resolver.invalidate('Ada@Company.com');
    await resolver.rolesFor(OPERATOR);

    expect(reads).toBe(2);
  });
});
