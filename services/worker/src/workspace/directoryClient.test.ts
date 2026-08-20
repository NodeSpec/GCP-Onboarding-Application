import { describe, expect, it } from 'vitest';
import {
  AdminRoleNotGrantedError,
  DEFAULT_RETRY,
  DirectoryClient,
  WorkspaceError,
  classify,
} from './directoryClient.js';

/**
 * TC-REQ-013-3, TC-REQ-013-4 and TC-REQ-013-6.
 *
 * classify() is pure, so the classification table is swept exhaustively. The
 * retry loop is exercised through a helper that mirrors the client's behaviour
 * against a stubbed operation, which keeps these tests free of googleapis and
 * of real network calls.
 *
 * Note the deliberate gap: the retry loop inside DirectoryClient.call is
 * currently reachable only by constructing the client, which builds a
 * GoogleAuth. Testing it directly needs an injection seam, so the coverage
 * below is of the CLASSIFICATION policy rather than of the loop itself. That
 * seam is worth adding before the loop grows any more behaviour.
 */

describe('classify', () => {
  it.each([429, 500, 502, 503, 504])('treats %i as retryable', (status) => {
    expect(classify(status)).toBe('retryable');
  });

  it.each([400, 401, 422])('treats %i as terminal', (status) => {
    expect(classify(status)).toBe('terminal');
  });

  it('treats 403 as a permission problem, not a terminal failure', () => {
    // Kept distinct so a missing admin privilege surfaces as its own error
    // naming the console path, rather than as a generic terminal failure
    // (REQ-008 AC-5).
    expect(classify(403)).toBe('permission');
  });

  it('treats 404 as not_found so callers can express "already absent"', () => {
    // deleteUser and removeMember depend on this to be idempotent (REQ-006).
    expect(classify(404)).toBe('not_found');
  });

  it('treats 409 as conflict so addMember can read it as already-satisfied', () => {
    expect(classify(409)).toBe('conflict');
  });

  /**
   * A network fault produces no status at all. Classifying that as terminal
   * would fail a step for a dropped connection, so the absent case is
   * deliberately retryable.
   */
  it('treats an absent status as retryable', () => {
    expect(classify(undefined)).toBe('retryable');
  });
});

describe('error types', () => {
  it('AdminRoleNotGrantedError names the console path an operator needs', () => {
    const err = new AdminRoleNotGrantedError('users.insert', 'insufficient permission');

    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.errorClass).toBe('permission');
    expect(err.status).toBe(403);
    expect(err.operation).toBe('users.insert');
    // The message is what an operator reads on a failed step, so it has to say
    // where to go, not just what broke.
    expect(err.message).toContain('Admin roles');
    expect(err.message).toContain('users.insert');
  });

  it('WorkspaceError carries the operation for step error reporting', () => {
    const err = new WorkspaceError('boom', 'terminal', 400, 'members.insert');
    expect(err.operation).toBe('members.insert');
    expect(err.errorClass).toBe('terminal');
  });

  it('preserves the underlying cause for diagnosis', () => {
    const cause = new Error('socket hang up');
    const err = new WorkspaceError('wrapped', 'retryable', undefined, 'users.get', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('retry policy shape', () => {
  it('declares a bounded attempt budget', () => {
    // An unbounded budget would let a persistently failing step hold a worker
    // instance until Cloud Run reclaims it.
    expect(DEFAULT_RETRY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY.maxAttempts).toBeLessThanOrEqual(8);
    expect(DEFAULT_RETRY.maxDelayMs).toBeGreaterThan(DEFAULT_RETRY.baseDelayMs);
  });
});

/**
 * The membership listing, against a fake Directory API.
 *
 * This call has been written wrong twice, in opposite directions, and each
 * version failed only in production. These tests pin the third version to the
 * two facts the live failures established: customer and userKey are mutually
 * exclusive on groups.list, and a 404 from the userKey-only shape must fall
 * back to per-group checks rather than escape, because role resolution and
 * the offboarding phase both walk through here.
 */
describe('listMemberships', () => {
  interface FakeCalls {
    groupsList: Record<string, unknown>[];
    hasMember: { groupKey: string; memberKey: string }[];
  }

  function build(handlers: {
    byMember: (params: Record<string, unknown>) => { email: string }[];
    tenantGroups?: { email: string }[];
    memberOf?: string[];
  }) {
    const calls: FakeCalls = { groupsList: [], hasMember: [] };

    const api = {
      groups: {
        list: (params: Record<string, unknown>) => {
          calls.groupsList.push(params);
          // The fake enforces what the real API enforces: the two scopes are
          // mutually exclusive, and a fake that accepted both would let the
          // deployed-and-reverted bug pass its own test.
          if ('userKey' in params && 'customer' in params) {
            return Promise.reject(Object.assign(new Error('Bad Request'), { code: 400 }));
          }
          if ('userKey' in params) {
            return Promise.resolve({ data: { groups: handlers.byMember(params) } });
          }
          return Promise.resolve({ data: { groups: handlers.tenantGroups ?? [] } });
        },
      },
      members: {
        hasMember: (params: { groupKey: string; memberKey: string }) => {
          calls.hasMember.push(params);
          return Promise.resolve({ data: { isMember: (handlers.memberOf ?? []).includes(params.groupKey) } });
        },
      },
    } as never;

    const client = new DirectoryClient({
      customerId: 'C01ab2cd3',
      api,
      transferApi: {} as never,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {},
    });

    return { client, calls };
  }

  it('sends userKey alone, never combined with customer', async () => {
    const { client, calls } = build({
      byMember: () => [{ email: 'engineering@company.com' }, { email: 'platform@company.com' }],
    });

    const groups = await client.listMemberships('ada@company.com');

    expect(groups).toEqual(['engineering@company.com', 'platform@company.com']);
    expect(calls.groupsList).toHaveLength(1);
    expect(calls.groupsList[0]).toMatchObject({ userKey: 'ada@company.com' });
    expect(calls.groupsList[0]).not.toHaveProperty('customer');
  });

  it('falls back to per-group membership checks when byMember answers 404', async () => {
    // The live shape of the delegated-service-account refusal: 404 "Domain
    // not found" from the userKey-only listing.
    const { client, calls } = build({
      byMember: () => {
        throw Object.assign(new Error('Domain not found.'), { code: 404 });
      },
      tenantGroups: [
        { email: 'engineering@company.com' },
        { email: 'platform@company.com' },
        { email: 'social@company.com' },
      ],
      memberOf: ['engineering@company.com', 'social@company.com'],
    });

    const groups = await client.listMemberships('ada@company.com');

    expect(groups).toEqual(['engineering@company.com', 'social@company.com']);
    // The fallback listing is tenant-scoped, which is the shape that works.
    expect(calls.groupsList.at(-1)).toMatchObject({ customer: 'C01ab2cd3' });
    // And every group was asked about exactly once.
    expect(calls.hasMember.map((c) => c.groupKey)).toEqual([
      'engineering@company.com',
      'platform@company.com',
      'social@company.com',
    ]);
    expect(calls.hasMember.every((c) => c.memberKey === 'ada@company.com')).toBe(true);
  });

  it('propagates a failure that is not the known 404, rather than guessing', async () => {
    const { client } = build({
      byMember: () => {
        throw Object.assign(new Error('Backend Error'), { code: 503 });
      },
    });

    await expect(client.listMemberships('ada@company.com')).rejects.toBeInstanceOf(WorkspaceError);
  });
});

/**
 * TC-REQ-013-6: retry and classification live in the shared client, not in the
 * phase handlers. Asserted as a source check because the property is about
 * where code lives rather than what it computes at runtime.
 */
describe('single choke point', () => {
  it('no phase handler implements its own retry or backoff', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const phasesDir = new URL('../phases/', import.meta.url).pathname;
    const entries = await readdir(phasesDir);
    const sources = entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

    expect(sources.length).toBeGreaterThan(0);

    for (const name of sources) {
      const body = await readFile(join(phasesDir, name), 'utf8');
      // Any of these in a phase handler means the policy has been duplicated.
      expect(body, `${name} should not implement retry`).not.toMatch(/setTimeout\s*\(/);
      expect(body, `${name} should not implement backoff`).not.toMatch(/backoff/i);
      expect(body, `${name} should not loop over attempts`).not.toMatch(/maxAttempts/);
    }
  });
});
