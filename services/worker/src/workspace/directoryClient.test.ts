import { describe, expect, it, vi } from 'vitest';
import { AdminRoleNotGrantedError, DEFAULT_RETRY, WorkspaceError, classify } from './directoryClient.js';

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
