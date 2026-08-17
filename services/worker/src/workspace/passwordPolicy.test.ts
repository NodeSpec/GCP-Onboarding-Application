import type { admin_directory_v1 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { DirectoryClient } from './directoryClient.js';

/**
 * TC-REQ-019-1, the generation half: what the initial password IS.
 *
 * The policy is asserted against the real generator, not a stub, because the
 * failure this guards is quiet weakening: someone shortens the password to make
 * a demo easier to type, or switches to an alphabet with ambiguous characters,
 * and every account created afterwards starts life behind a weaker credential
 * with nothing failing anywhere.
 */

function client(api?: admin_directory_v1.Admin): DirectoryClient {
  return new DirectoryClient({
    customerId: 'my_customer',
    api: api ?? ({} as admin_directory_v1.Admin),
    sleep: async () => {},
  });
}

describe('AC-1: the generated password meets the generation policy', () => {
  it('is 24 characters by default', () => {
    expect(client().generateInitialPassword()).toHaveLength(24);
  });

  it('honours an explicit length', () => {
    expect(client().generateInitialPassword(32)).toHaveLength(32);
  });

  it('draws only from the base64url alphabet, with no ambiguous characters', () => {
    // The operator reads this aloud during handover. '+', '/' and '=' are the
    // characters that get mis-transcribed, and base64url has none of them.
    for (let i = 0; i < 50; i += 1) {
      expect(client().generateInitialPassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
    }
  });

  it('never repeats across draws', () => {
    // 24 characters over a 64-symbol alphabet is 144 bits. A single collision
    // in ten thousand draws means the randomness source is broken, not unlucky.
    const draws = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      draws.add(client().generateInitialPassword());
    }

    expect(draws.size).toBe(10_000);
  });

  it('carries enough entropy that no character position is fixed', () => {
    // A generator that prefixed a constant would pass the length and charset
    // checks while quietly shrinking the search space.
    const draws = Array.from({ length: 200 }, () => client().generateInitialPassword());

    for (let position = 0; position < 24; position += 1) {
      const symbols = new Set(draws.map((d) => d[position]));
      expect(symbols.size).toBeGreaterThan(10);
    }
  });
});

describe('AC-1: the account is created with changePasswordAtNextLogin=true', () => {
  it('sends the flag on users.insert, taken from the input rather than defaulted away', async () => {
    const inserts: admin_directory_v1.Schema$User[] = [];
    const api = {
      users: {
        insert: async (params: { requestBody: admin_directory_v1.Schema$User }) => {
          inserts.push(params.requestBody);
          return { data: params.requestBody };
        },
      },
    } as unknown as admin_directory_v1.Admin;

    await client(api).insertUser({
      primaryEmail: 'ada.lovelace@company.com',
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      password: 'irrelevant-here',
      changePasswordAtNextLogin: true,
      orgUnitPath: '/',
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.changePasswordAtNextLogin).toBe(true);
  });
});
