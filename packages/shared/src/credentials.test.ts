import { randomBytes } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS, credentialState, type CredentialHandoff } from './model.js';
import {
  CredentialStore,
  CredentialUnrecoverableError,
  type KeyProvider,
  type ResolvedKey,
  unpack,
} from './credentials.js';

/**
 * TC-REQ-019-2, TC-REQ-019-3 and TC-REQ-019-6.
 *
 * The key provider and the database are both injected, so the encryption round
 * trip runs for real against real AES-256-GCM with only Secret Manager and
 * Firestore substituted. The crypto is the part under test and none of it is
 * faked.
 *
 * What is NOT covered here: the transactional single-retrieval guarantee and
 * the TTL expiry both depend on real Firestore semantics, and a hand-rolled
 * fake would only prove the fake works. Those belong to the emulator suite.
 */

const PASSWORD = 'Correct-Horse-Battery-Staple-42!';

/**
 * A provider holding one or more key versions, newest last. Models Secret
 * Manager's default behaviour: prior versions stay accessible until they are
 * explicitly destroyed. Asking for a version it does not hold throws, which is
 * what a destroyed version looks like.
 */
function rotatingProvider(versions: [string, Buffer][]): KeyProvider {
  const held = new Map(versions.map(([version, key]) => [version, { key, version }]));
  const [latestVersion, latestKey] = versions[versions.length - 1]!;

  return {
    resolve: async (): Promise<ResolvedKey> => ({ key: latestKey, version: latestVersion }),
    resolveVersion: async (version: string): Promise<ResolvedKey> => {
      const found = held.get(version);
      if (!found) throw new Error(`Secret version ${version} is not accessible`);
      return found;
    },
  };
}

/** A fixed single-version key, so a failure is never a flaky key generation. */
function keyProvider(version = 'projects/1/secrets/credkey/versions/1', key = randomBytes(32)): KeyProvider {
  return rotatingProvider([[version, key]]);
}

/** Minimal Firestore stand-in: one collection of documents, plus transactions. */
class FakeDb {
  readonly docs = new Map<string, Record<string, unknown>>();
  readonly writes: { path: string; data: Record<string, unknown> }[] = [];

  collection(name: string) {
    return {
      doc: (id: string) => ({
        path: `${name}/${id}`,
        get: async () => this.snapshot(`${name}/${id}`),
      }),
    };
  }

  private snapshot(path: string) {
    const data = this.docs.get(path);
    return { exists: data !== undefined, data: () => data };
  }

  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      get: async (ref: { path: string }) => this.snapshot(ref.path),
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        this.docs.set(ref.path, { ...this.docs.get(ref.path), ...patch });
      },
    };
    return fn(tx);
  }
}

/**
 * The store writes through `ref.set`, which the fake collection above does not
 * expose, so it is added here where the recorded write can also be captured.
 */
function db(): FakeDb {
  const fake = new FakeDb();
  const original = fake.collection.bind(fake);
  fake.collection = (name: string) => {
    const base = original(name);
    return {
      doc: (id: string) => ({
        ...base.doc(id),
        set: async (data: Record<string, unknown>) => {
          fake.docs.set(`${name}/${id}`, data);
          fake.writes.push({ path: `${name}/${id}`, data });
        },
      }),
      // Equality only, which is all currentFor issues. The ordering it needs is
      // done in memory precisely so no composite index is required, so a fake
      // that supported orderBy would be testing something the code never does.
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...fake.docs.entries()]
            .filter(([path]) => path.startsWith(`${name}/`))
            .filter(([, data]) => data[field] === value)
            .map(([path, data]) => ({ id: path.slice(name.length + 1), data: () => data })),
        }),
      }),
    };
  };
  return fake;
}

let fake: FakeDb;

beforeEach(() => {
  fake = db();
});

const recordFor = (requestId: string) =>
  fake.docs.get(`${COLLECTIONS.credentialHandoffs}/${requestId}`) as unknown as CredentialHandoff;

describe('AC-2: the one-time password is stored only as ciphertext', () => {
  it('decrypts back to exactly the issued value', async () => {
    const store = new CredentialStore(fake as never, keyProvider());

    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });
    const retrieved = await store.retrieveOnce('req-1');

    expect(retrieved).toEqual({ primaryEmail: 'ada@company.com', password: PASSWORD });
  });

  it('persists no plaintext anywhere in the stored record', async () => {
    const store = new CredentialStore(fake as never, keyProvider());

    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    expect(JSON.stringify([...fake.docs.values()])).not.toContain(PASSWORD);
    expect(JSON.stringify(fake.writes)).not.toContain(PASSWORD);
  });

  it('stores a reversible ciphertext rather than a hash', async () => {
    const store = new CredentialStore(fake as never, keyProvider());

    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });
    const parts = unpack(recordFor('req-1').oneTimePasswordCiphertext);

    // A hash would be fixed width with no IV and no auth tag, and could not be
    // reversed. The operator has to recover the real password to hand it over.
    expect(parts).not.toBeNull();
    expect(parts!.iv).toHaveLength(12);
    expect(parts!.tag).toHaveLength(16);
    expect(parts!.data).toHaveLength(Buffer.byteLength(PASSWORD, 'utf8'));
  });

  it('uses a fresh initialisation vector for every record', async () => {
    const store = new CredentialStore(fake as never, keyProvider());

    await store.stash({ requestId: 'req-1', primaryEmail: 'a@company.com', password: PASSWORD, ttlHours: 72 });
    await store.stash({ requestId: 'req-2', primaryEmail: 'b@company.com', password: PASSWORD, ttlHours: 72 });

    const first = recordFor('req-1').oneTimePasswordCiphertext;
    const second = recordFor('req-2').oneTimePasswordCiphertext;

    // Same password, same key, different record: an IV reuse would make these
    // identical, which under GCM is a key-recovery grade mistake.
    expect(first).not.toBe(second);
    expect(unpack(first)!.iv.equals(unpack(second)!.iv)).toBe(false);
  });

  it('refuses a record whose ciphertext has been tampered with', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    const record = recordFor('req-1');
    const [iv, data, tag] = record.oneTimePasswordCiphertext.split('.') as [string, string, string];
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    record.oneTimePasswordCiphertext = [iv, flipped.toString('base64url'), tag].join('.');

    // GCM authenticates as well as encrypts, so a modified record fails rather
    // than returning a corrupted password.
    await expect(store.retrieveOnce('req-1')).rejects.toThrow();
  });

  it('cannot be decrypted with a different key', async () => {
    const write = new CredentialStore(fake as never, keyProvider('v1', randomBytes(32)));
    await write.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    const read = new CredentialStore(fake as never, keyProvider('v1', randomBytes(32)));
    await expect(read.retrieveOnce('req-1')).rejects.toThrow();
  });
});

describe('AC-3: the record carries the key version it was written under', () => {
  it('records the resolving key version alongside the ciphertext', async () => {
    const store = new CredentialStore(fake as never, keyProvider('projects/1/secrets/credkey/versions/7'));

    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    expect(recordFor('req-1').keyVersion).toBe('projects/1/secrets/credkey/versions/7');
  });

  it('decrypts ciphertext written under a previous key version after a rotation', async () => {
    const v1 = randomBytes(32);
    const writer = new CredentialStore(fake as never, rotatingProvider([['versions/1', v1]]));
    await writer.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    // Routine rotation: v2 becomes current, v1 is retained as Secret Manager
    // retains it. The record's keyVersion is what makes this recoverable.
    const afterRotation = new CredentialStore(
      fake as never,
      rotatingProvider([['versions/1', v1], ['versions/2', randomBytes(32)]]),
    );

    await expect(afterRotation.retrieveOnce('req-1')).resolves.toEqual({
      primaryEmail: 'ada@company.com',
      password: PASSWORD,
    });
  });

  it('reports a destroyed key version as unrecoverable, not as corruption', async () => {
    const writer = new CredentialStore(fake as never, rotatingProvider([['versions/1', randomBytes(32)]]));
    await writer.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    // Emergency rotation destroys the old version. Unreadable ciphertext is the
    // intended outcome; what matters is that it is diagnosable.
    const afterDestroy = new CredentialStore(fake as never, rotatingProvider([['versions/2', randomBytes(32)]]));

    const err = await afterDestroy.retrieveOnce('req-1').catch((e: Error) => e);
    expect(err).toBeInstanceOf(CredentialUnrecoverableError);
    expect((err as Error).message).toContain('Regenerate');
  });

  it('leaves the ciphertext intact when the key cannot be resolved', async () => {
    const writer = new CredentialStore(fake as never, rotatingProvider([['versions/1', randomBytes(32)]]));
    await writer.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });
    const before = recordFor('req-1').oneTimePasswordCiphertext;

    const afterDestroy = new CredentialStore(fake as never, rotatingProvider([['versions/2', randomBytes(32)]]));
    await afterDestroy.retrieveOnce('req-1').catch(() => undefined);

    // The claim destroys the ciphertext, so resolving the key AFTER it would
    // turn a recoverable failure into permanent loss. Key resolution happens
    // first, and a failure leaves the record untouched and still claimable.
    expect(recordFor('req-1').oneTimePasswordCiphertext).toBe(before);
    expect(recordFor('req-1').retrievedAt).toBeNull();
  });
});

describe('AC-6: the plaintext is discarded once the ciphertext is committed', () => {
  it('retains no reference to the password on the store instance', async () => {
    const store = new CredentialStore(fake as never, keyProvider());

    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    // Nothing on the instance, at any depth, holds the plaintext.
    expect(JSON.stringify(store, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(PASSWORD);
    for (const value of Object.values(store as unknown as Record<string, unknown>)) {
      expect(JSON.stringify(value ?? null)).not.toContain(PASSWORD);
    }
  });

  it('destroys the ciphertext on retrieval rather than flagging the record', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    await store.retrieveOnce('req-1');

    // A flag left beside readable ciphertext is one bug away from a second read.
    expect(recordFor('req-1').oneTimePasswordCiphertext).toBe('');
    expect(recordFor('req-1').retrievedAt).not.toBeNull();
  });

  it('yields nothing on a second retrieval', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    await expect(store.retrieveOnce('req-1')).resolves.toMatchObject({ password: PASSWORD });
    await expect(store.retrieveOnce('req-1')).resolves.toBeNull();
  });

  it('yields nothing for a record that has expired', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    recordFor('req-1').expiresAt = Timestamp.fromMillis(Date.now() - 1000);

    await expect(store.retrieveOnce('req-1')).resolves.toBeNull();
  });

  it('yields nothing for a request that was never stashed', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await expect(store.retrieveOnce('never-existed')).resolves.toBeNull();
  });

  it('reports absent, already-taken and expired identically to the caller', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'taken', primaryEmail: 'a@company.com', password: PASSWORD, ttlHours: 72 });
    await store.retrieveOnce('taken');
    await store.stash({ requestId: 'expired', primaryEmail: 'b@company.com', password: PASSWORD, ttlHours: 72 });
    recordFor('expired').expiresAt = Timestamp.fromMillis(Date.now() - 1000);

    // Distinguishing the three would tell an unauthorised caller more than
    // they should learn.
    expect(await store.retrieveOnce('absent')).toBeNull();
    expect(await store.retrieveOnce('taken')).toBeNull();
    expect(await store.retrieveOnce('expired')).toBeNull();
  });
});

/**
 * TC-REQ-030-3 and TC-REQ-030-5: what "still usable" means, and what stops
 * being usable once a regeneration has happened.
 *
 * credentialState is the one predicate the resend precondition and retrieval
 * both consult. Testing it directly is worth more than testing either caller,
 * because the failure it guards against is the two disagreeing: a resend that
 * says the credential is fine followed by a retrieval that says it is gone.
 */

function handoff(overrides: Partial<CredentialHandoff> = {}): CredentialHandoff {
  return {
    primaryEmail: 'ada@company.com',
    oneTimePasswordCiphertext: 'iv.data.tag',
    keyVersion: 'v1',
    retrievedAt: null,
    expiresAt: Timestamp.fromMillis(2_000),
    supersededAt: null,
    supersededBy: null,
    ...overrides,
  };
}

describe('AC-3: whether a stored credential can still be handed over', () => {
  it('calls an unused, unexpired, unsuperseded record valid', () => {
    expect(credentialState(handoff(), 1_000)).toBe('valid');
  });

  it('calls a retrieved record retrieved', () => {
    expect(credentialState(handoff({ retrievedAt: Timestamp.fromMillis(500) }), 1_000)).toBe('retrieved');
  });

  it('calls a record expired at the instant its TTL passes, not a millisecond later', () => {
    // The boundary is inclusive: at exactly expiresAt the credential is gone.
    // An off-by-one here hands over a password the TTL was supposed to retire.
    expect(credentialState(handoff({ expiresAt: Timestamp.fromMillis(1_000) }), 1_000)).toBe('expired');
    expect(credentialState(handoff({ expiresAt: Timestamp.fromMillis(1_001) }), 1_000)).toBe('valid');
  });

  it('calls a superseded record superseded even though it was also emptied', () => {
    // Both are true of a superseded record. Reporting 'destroyed' would hide the
    // fact that a regeneration is why, which is the one thing an operator
    // chasing a 410 needs to know.
    const superseded = handoff({
      oneTimePasswordCiphertext: '',
      supersededAt: Timestamp.fromMillis(900),
      supersededBy: 'req-2',
    });

    expect(credentialState(superseded, 1_000)).toBe('superseded');
  });

  it('tolerates a record written before regeneration existed', () => {
    // Documents stashed by the create phase before REQ-030 carry neither field.
    // An absent supersededAt has to read as "not superseded", not as unset.
    const { supersededAt: _a, supersededBy: _b, ...legacy } = handoff();

    expect(credentialState(legacy as CredentialHandoff, 1_000)).toBe('valid');
  });

  it('reports a record whose ciphertext was emptied without a reason', () => {
    expect(credentialState(handoff({ oneTimePasswordCiphertext: '' }), 1_000)).toBe('destroyed');
  });
});

describe('AC-3: finding the credential a resend would reuse', () => {
  it('finds the stored credential for an address', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    await expect(store.currentFor('ada@company.com')).resolves.toMatchObject({ requestId: 'req-1' });
  });

  it('matches the address case-insensitively, since identity must not fork on case', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    await expect(store.currentFor('Ada@Company.com')).resolves.toMatchObject({ requestId: 'req-1' });
  });

  it('ignores another user credential entirely', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'grace@company.com', password: PASSWORD, ttlHours: 72 });

    await expect(store.currentFor('ada@company.com')).resolves.toBeNull();
  });

  it('ignores a retrieved record, which is the dead end resend exists to close', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });
    await store.retrieveOnce('req-1');

    await expect(store.currentFor('ada@company.com')).resolves.toBeNull();
  });

  it('ignores an expired record', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });
    recordFor('req-1').expiresAt = Timestamp.fromMillis(Date.now() - 1);

    await expect(store.currentFor('ada@company.com')).resolves.toBeNull();
  });

  it('prefers the newest of several live records for the same person', async () => {
    // Two live records is not a normal state, but it is reachable: a rotation
    // that committed the new record and then failed before the invalidation.
    // Picking the older one would hand over a password that no longer signs in.
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'older', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 1 });
    await store.stash({ requestId: 'newer', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    await expect(store.currentFor('ada@company.com')).resolves.toMatchObject({ requestId: 'newer' });
  });
});

describe('AC-5: a superseded record yields nothing', () => {
  it('refuses to decrypt a record marked superseded', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    // Marked but NOT emptied, which is the case the flag has to carry on its
    // own. If only the emptying stopped retrieval, a rotation that failed
    // between the two writes would leave the old password retrievable.
    recordFor('req-1').supersededAt = Timestamp.now();
    recordFor('req-1').supersededBy = 'req-2';

    await expect(store.retrieveOnce('req-1')).resolves.toBeNull();
  });

  it('leaves a superseded record out of what a later resend would reuse', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });
    recordFor('req-1').supersededAt = Timestamp.now();

    await expect(store.currentFor('ada@company.com')).resolves.toBeNull();
  });
});

describe('AC-4: sealing a password without writing it', () => {
  it('produces a record that decrypts back to the password', async () => {
    // Rotation needs the ciphertext BEFORE the transaction that installs it,
    // because crypto cannot happen inside a transaction handler that may be
    // retried. This is that split, and the round trip still has to hold.
    const store = new CredentialStore(fake as never, keyProvider());
    const sealed = await store.seal({ primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    fake.docs.set(`${COLLECTIONS.credentialHandoffs}/req-9`, sealed as unknown as Record<string, unknown>);

    await expect(store.retrieveOnce('req-9')).resolves.toMatchObject({ password: PASSWORD });
  });

  it('writes nothing, so a failed rotation leaves no orphan record', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    await store.seal({ primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    expect(fake.writes).toEqual([]);
    expect(fake.docs.size).toBe(0);
  });

  it('carries no plaintext anywhere in the sealed record', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    const sealed = await store.seal({ primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    expect(JSON.stringify(sealed)).not.toContain(PASSWORD);
  });

  it('starts life unretrieved and unsuperseded', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    const sealed = await store.seal({ primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    expect(credentialState(sealed, Date.now())).toBe('valid');
  });

  it('gives each sealing its own IV, so two identical passwords do not collide', async () => {
    const store = new CredentialStore(fake as never, keyProvider());
    const a = await store.seal({ primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });
    const b = await store.seal({ primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    expect(a.oneTimePasswordCiphertext).not.toBe(b.oneTimePasswordCiphertext);
    expect(unpack(a.oneTimePasswordCiphertext)!.iv.equals(unpack(b.oneTimePasswordCiphertext)!.iv)).toBe(false);
  });
});
