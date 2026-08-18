import type { admin_directory_v1 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import {
  AdminRoleNotGrantedError,
  DEFAULT_RETRY,
  DirectoryClient,
  WorkspaceError,
  backoffMs,
} from './directoryClient.js';

/**
 * TC-REQ-013-3 and TC-REQ-013-4: the retry and classification rules.
 *
 * The Directory API and the retry clock are both injected, so what runs here is
 * the real call loop making real decisions about real error shapes, with only
 * the network and the elapsed time substituted. Every delay the loop would have
 * waited is recorded instead, which is what makes the backoff assertions
 * possible at all.
 */

const stubApi = {} as admin_directory_v1.Admin;

interface Harness {
  client: DirectoryClient;
  delays: number[];
}

function harness(options: { retry?: Partial<typeof DEFAULT_RETRY>; random?: () => number } = {}): Harness {
  const delays: number[] = [];
  const client = new DirectoryClient({
    customerId: 'my_customer',
    api: stubApi,
    retry: { ...DEFAULT_RETRY, ...options.retry },
    sleep: async (ms) => {
      delays.push(ms);
    },
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  return { client, delays };
}

/** A googleapis-shaped error: status on the object, headers on the response. */
function apiError(status: number, headers: Record<string, string> = {}) {
  return { code: status, message: `synthetic ${status}`, response: { status, headers } };
}

describe('AC-3: transient failures are retried with backoff', () => {
  it('retries a 429 and succeeds when the call eventually works', async () => {
    const { client, delays } = harness();
    let attempts = 0;

    const result = await client.call('getUser', async () => {
      attempts += 1;
      if (attempts < 3) throw apiError(429);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it.each([500, 502, 503, 504])('retries a %d from the Directory API', async (status) => {
    const { client } = harness();
    let attempts = 0;

    await client.call('insertUser', async () => {
      attempts += 1;
      if (attempts < 2) throw apiError(status);
      return 'ok';
    });

    expect(attempts).toBe(2);
  });

  it('retries a transport failure that carries no status at all', async () => {
    const { client } = harness();
    let attempts = 0;

    await client.call('getUser', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('socket hang up');
      return 'ok';
    });

    expect(attempts).toBe(2);
  });

  it('grows the backoff ceiling exponentially between attempts', async () => {
    // random pinned to 1 so each delay IS its ceiling, making the growth
    // observable rather than a distribution that has to be sampled.
    const { client, delays } = harness({ random: () => 1 });

    await client
      .call('getUser', async () => {
        throw apiError(503);
      })
      .catch(() => undefined);

    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });

  it('caps the ceiling at maxDelayMs however many attempts have failed', () => {
    const policy = { maxAttempts: 12, baseDelayMs: 500, maxDelayMs: 20_000 };
    for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
      expect(backoffMs(attempt, policy, () => 1)).toBeLessThanOrEqual(policy.maxDelayMs);
    }
    expect(backoffMs(11, policy, () => 1)).toBe(20_000);
  });

  it('applies jitter, so retries from many instances do not align', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 20_000 };
    const draws = [0, 0.25, 0.5, 0.75, 0.999].map((r) => backoffMs(3, policy, () => r));

    expect(new Set(draws).size).toBe(draws.length);
    for (const draw of draws) {
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThanOrEqual(4000);
    }
  });

  it('honours Retry-After in preference to its own backoff', async () => {
    const { client, delays } = harness({ random: () => 1 });
    let attempts = 0;

    await client.call('addMember', async () => {
      attempts += 1;
      if (attempts < 2) throw apiError(429, { 'retry-after': '7' });
      return 'ok';
    });

    // 7000 from the header, not the 500 the first backoff ceiling would give.
    expect(delays).toEqual([7000]);
  });

  it('ignores an unparseable Retry-After and falls back to backoff', async () => {
    const { client, delays } = harness({ random: () => 1 });
    let attempts = 0;

    await client.call('addMember', async () => {
      attempts += 1;
      if (attempts < 2) throw apiError(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
      return 'ok';
    });

    expect(delays).toEqual([500]);
  });

  it('gives up after the configured attempt budget and reports the class', async () => {
    const { client, delays } = harness({ retry: { maxAttempts: 3 } });
    let attempts = 0;

    const failing = client.call('getUser', async () => {
      attempts += 1;
      throw apiError(503);
    });

    await expect(failing).rejects.toBeInstanceOf(WorkspaceError);
    await expect(failing).rejects.toMatchObject({ errorClass: 'retryable', operation: 'getUser' });
    expect(attempts).toBe(3);
    // Waits happen BETWEEN attempts, never after the last one.
    expect(delays).toHaveLength(2);
  });

  it('preserves the last underlying error as the cause', async () => {
    const { client } = harness({ retry: { maxAttempts: 2 } });
    const underlying = apiError(503);

    const err = await client
      .call('getUser', async () => {
        throw underlying;
      })
      .catch((e: Error) => e);

    expect((err as Error).cause).toBe(underlying);
  });
});

describe('AC-4: a client error fails the step immediately', () => {
  it.each([
    [400, 'terminal'],
    [401, 'terminal'],
    [422, 'terminal'],
  ])('fails a %d without consuming further attempts', async (status, errorClass) => {
    const { client, delays } = harness();
    let attempts = 0;

    const failing = client.call('insertUser', async () => {
      attempts += 1;
      throw apiError(status);
    });

    await expect(failing).rejects.toMatchObject({ errorClass, status });
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('fails a 403 immediately as a permission problem', async () => {
    const { client, delays } = harness();
    let attempts = 0;

    const failing = client.call('insertUser', async () => {
      attempts += 1;
      throw apiError(403);
    });

    await expect(failing).rejects.toBeInstanceOf(AdminRoleNotGrantedError);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('leaves the whole retry budget unspent when the first attempt is terminal', async () => {
    const { client } = harness({ retry: { maxAttempts: 5 } });
    let attempts = 0;

    await client
      .call('deleteUser', async () => {
        attempts += 1;
        throw apiError(400);
      })
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });

  it('does not retry 404 or 409, which callers read as already-satisfied', async () => {
    for (const status of [404, 409]) {
      const { client } = harness();
      let attempts = 0;

      await client
        .call('addMember', async () => {
          attempts += 1;
          throw apiError(status);
        })
        .catch(() => undefined);

      expect(attempts, `status ${status} should not be retried`).toBe(1);
    }
  });
});
