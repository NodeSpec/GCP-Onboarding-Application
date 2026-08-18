import { describe, expect, it } from 'vitest';
import { WorkerGroupMemberships } from './groupMemberships.js';
import { LookupUnavailable, WorkerLookupClient } from './workerClient.js';
import { BindingRoleResolver } from '../roles.js';
import { Timestamp } from '@google-cloud/firestore';
import type { LifecycleStore, OperatorRole, RoleBinding } from '@lifecycle/shared';
import type { OperatorIdentity } from '../middleware/iapAuth.js';

/**
 * TC-REQ-012-7: a group binding grants in a deployment what it grants in test.
 *
 * The resolver always knew how to union a group binding into an operator's
 * roles, and that logic was tested against a fake membership provider. What was
 * missing was the real one: the deployed entry point supplied none, so the
 * group path resolved correctly in test and granted nothing in production.
 * That is the worst shape a permission check can have, because both the code
 * and its tests look right.
 *
 * These tests exercise the adapter that closes it, and then the resolver
 * driving the adapter, so what is asserted is the wiring rather than the branch
 * in isolation.
 */

/** A worker lookup client that answers from a fixture and counts calls. */
function fakeClient(
  answers: Record<string, { groups: string[] } | LookupUnavailable | Error>,
): { client: WorkerLookupClient; calls: string[] } {
  const calls: string[] = [];

  const client = new WorkerLookupClient({
    baseUrl: 'https://worker.example',
    tokenSource: async () => 'token',
    fetchImpl: (async () => {
      throw new Error('the fetch path is not exercised here');
    }) as unknown as typeof fetch,
  });

  // Replace the one method the provider uses. Going through `get` rather than
  // stubbing fetch keeps the status-to-meaning mapping (404 versus everything
  // else) in the client where it belongs.
  (client as unknown as { get: (path: string) => Promise<unknown> }).get = async (path) => {
    calls.push(path);
    const email = decodeURIComponent(path.replace('/users/', ''));
    const answer = answers[email];
    if (answer === undefined) throw new LookupUnavailable('not found', 404);
    if (answer instanceof Error) throw answer;
    return { primaryEmail: email, groups: answer.groups };
  };

  return { client, calls };
}

describe('reading membership from the worker', () => {
  it('returns the groups the directory reports', async () => {
    const { client } = fakeClient({
      'ada@company.com': { groups: ['approvers@company.com', 'eng@company.com'] },
    });

    const provider = new WorkerGroupMemberships({ client });

    expect(await provider.groupsFor('ada@company.com')).toEqual([
      'approvers@company.com',
      'eng@company.com',
    ]);
  });

  it('normalises the address, so a differently-cased sign-in resolves the same', async () => {
    const { client, calls } = fakeClient({
      'ada@company.com': { groups: ['approvers@company.com'] },
    });

    const provider = new WorkerGroupMemberships({ client });

    expect(await provider.groupsFor('Ada@Company.com  ')).toEqual(['approvers@company.com']);
    expect(calls).toEqual(['/users/ada%40company.com']);
  });

  it('treats a 404 as no memberships rather than as a failure', async () => {
    // The realistic case is a bootstrap admin from outside the tenant. They are
    // not a Workspace user, so they belong to no group in this domain.
    // Erroring here would make them unable to sign in at all, which would break
    // the only route into an empty binding store.
    const { client } = fakeClient({});
    const provider = new WorkerGroupMemberships({ client });

    expect(await provider.groupsFor('consultant@elsewhere.example')).toEqual([]);
  });

  it('propagates any other failure rather than reporting no memberships', async () => {
    // The distinction that matters. Returning [] on a Directory outage would
    // silently downgrade an operator to their individual roles, and a partial
    // authorization decision is indistinguishable from a deliberate one.
    const { client } = fakeClient({
      'ada@company.com': new LookupUnavailable('directory lookup returned 503', 503),
    });

    const provider = new WorkerGroupMemberships({ client });

    await expect(provider.groupsFor('ada@company.com')).rejects.toBeInstanceOf(LookupUnavailable);
  });

  it('does not cache a failure, so the next request tries again', async () => {
    let attempt = 0;
    const client = new WorkerLookupClient({
      baseUrl: 'https://worker.example',
      tokenSource: async () => 'token',
    });
    (client as unknown as { get: () => Promise<unknown> }).get = async () => {
      attempt += 1;
      if (attempt === 1) throw new LookupUnavailable('unavailable', 503);
      return { primaryEmail: 'ada@company.com', groups: ['approvers@company.com'] };
    };

    const provider = new WorkerGroupMemberships({ client });

    await expect(provider.groupsFor('ada@company.com')).rejects.toBeTruthy();
    expect(await provider.groupsFor('ada@company.com')).toEqual(['approvers@company.com']);
  });
});

describe('caching, and what it is allowed to make stale', () => {
  it('reuses a membership list within the TTL rather than calling per request', async () => {
    // Roles are resolved on every authorized request. Without this, each one
    // costs a Directory round trip, in front of an operator and against the
    // same quota the step queue is throttled to protect.
    const { client, calls } = fakeClient({
      'ada@company.com': { groups: ['approvers@company.com'] },
    });

    let now = 1_000;
    const provider = new WorkerGroupMemberships({ client, ttlMs: 60_000, now: () => now });

    await provider.groupsFor('ada@company.com');
    await provider.groupsFor('ada@company.com');
    now += 59_000;
    await provider.groupsFor('ada@company.com');

    expect(calls).toHaveLength(1);
  });

  it('re-reads once the TTL has passed', async () => {
    const { client, calls } = fakeClient({
      'ada@company.com': { groups: ['approvers@company.com'] },
    });

    let now = 1_000;
    const provider = new WorkerGroupMemberships({ client, ttlMs: 60_000, now: () => now });

    await provider.groupsFor('ada@company.com');
    now += 60_001;
    await provider.groupsFor('ada@company.com');

    expect(calls).toHaveLength(2);
  });

  it('collapses a burst for one operator into a single lookup', async () => {
    // A page load fires several authorized requests at once. Without this each
    // would start its own Directory call before the first finished.
    const { client, calls } = fakeClient({
      'ada@company.com': { groups: ['approvers@company.com'] },
    });

    const provider = new WorkerGroupMemberships({ client });

    const results = await Promise.all([
      provider.groupsFor('ada@company.com'),
      provider.groupsFor('ada@company.com'),
      provider.groupsFor('ada@company.com'),
    ]);

    expect(calls).toHaveLength(1);
    for (const result of results) expect(result).toEqual(['approvers@company.com']);
  });

  it('keeps separate operators separate', async () => {
    const { client } = fakeClient({
      'ada@company.com': { groups: ['approvers@company.com'] },
      'grace@company.com': { groups: ['admins@company.com'] },
    });

    const provider = new WorkerGroupMemberships({ client });

    expect(await provider.groupsFor('ada@company.com')).toEqual(['approvers@company.com']);
    expect(await provider.groupsFor('grace@company.com')).toEqual(['admins@company.com']);
  });

  it('can be invalidated for one operator', async () => {
    const { client, calls } = fakeClient({
      'ada@company.com': { groups: ['approvers@company.com'] },
    });

    const provider = new WorkerGroupMemberships({ client });

    await provider.groupsFor('ada@company.com');
    provider.invalidate('Ada@Company.com');
    await provider.groupsFor('ada@company.com');

    expect(calls).toHaveLength(2);
  });
});

// ------------------------------------------------------- the wiring itself

/** A role binding, with the bookkeeping fields filled in. */
const binding = (kind: 'user' | 'group', roles: OperatorRole[]): RoleBinding => ({
  kind,
  roles,
  updatedBy: 'admin@company.com',
  updatedAt: Timestamp.fromMillis(0),
});

/** A store that answers role bindings from a fixture. */
function fakeStore(bindings: Record<string, RoleBinding>): LifecycleStore {
  return {
    async getRoleBinding(subject: string) {
      return bindings[subject.toLowerCase()] ?? null;
    },
  } as unknown as LifecycleStore;
}

const identity = (email: string): OperatorIdentity =>
  ({ email, subject: `sub-${email}` }) as OperatorIdentity;

describe('REQ-012 AC-7: the resolver driving the real provider', () => {
  it('grants what a group binding carries, to somebody with no binding of their own', async () => {
    // The whole point. This person has no individual binding; every role they
    // hold comes through the group, which is what did not work in a deployment
    // before the provider was wired.
    const { client } = fakeClient({
      'ada@company.com': { groups: ['approvers@company.com'] },
    });

    const resolver = new BindingRoleResolver(
      fakeStore({
        'approvers@company.com': binding('group', ['approver']),
      }),
      { groups: new WorkerGroupMemberships({ client }) },
    );

    expect(await resolver.rolesFor(identity('ada@company.com'))).toEqual(['approver']);
  });

  it('unions a group binding with the operator’s own', async () => {
    const { client } = fakeClient({
      'ada@company.com': { groups: ['admins@company.com'] },
    });

    const resolver = new BindingRoleResolver(
      fakeStore({
        'ada@company.com': binding('user', ['requester']),
        'admins@company.com': binding('group', ['admin']),
      }),
      { groups: new WorkerGroupMemberships({ client }) },
    );

    expect(await resolver.rolesFor(identity('ada@company.com'))).toEqual(['admin', 'requester']);
  });

  it('grants nothing for a group the operator is in that has no binding', async () => {
    const { client } = fakeClient({
      'ada@company.com': { groups: ['everyone@company.com'] },
    });

    const resolver = new BindingRoleResolver(fakeStore({}), {
      groups: new WorkerGroupMemberships({ client }),
    });

    expect(await resolver.rolesFor(identity('ada@company.com'))).toEqual([]);
  });

  it('refuses rather than downgrading when membership cannot be read', async () => {
    // An operator with an individual 'requester' binding and a group 'admin'
    // binding must not quietly come back as requester-only during an outage.
    const { client } = fakeClient({
      'ada@company.com': new LookupUnavailable('directory lookup returned 503', 503),
    });

    const resolver = new BindingRoleResolver(
      fakeStore({
        'ada@company.com': binding('user', ['requester']),
      }),
      { groups: new WorkerGroupMemberships({ client }) },
    );

    await expect(resolver.rolesFor(identity('ada@company.com'))).rejects.toBeTruthy();
  });

  it('still admits a bootstrap admin who is not a Workspace user at all', async () => {
    // The 404 path, end to end. If this failed, an empty deployment would have
    // no way in.
    const { client } = fakeClient({});

    const resolver = new BindingRoleResolver(fakeStore({}), {
      bootstrapAdmins: ['founder@elsewhere.example'],
      groups: new WorkerGroupMemberships({ client }),
    });

    expect(await resolver.rolesFor(identity('founder@elsewhere.example'))).toEqual(['admin']);
  });

  it('does not let a group address grant itself roles by signing in', async () => {
    // A 'group' binding whose subject matches the caller's own address is not a
    // binding for that caller. Already asserted against the fake provider; kept
    // here because the real provider is what a group address would now be
    // looked up through.
    const { client } = fakeClient({ 'approvers@company.com': { groups: [] } });

    const resolver = new BindingRoleResolver(
      fakeStore({
        'approvers@company.com': binding('group', ['admin']),
      }),
      { groups: new WorkerGroupMemberships({ client }) },
    );

    expect(await resolver.rolesFor(identity('approvers@company.com'))).toEqual([]);
  });
});
