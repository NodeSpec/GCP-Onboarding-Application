import { randomBytes } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { COLLECTIONS, type CredentialHandoff } from '@lifecycle/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore, type KeyProvider, type ResolvedKey, unpack } from './credentialStore.js';

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

/** A fixed key, so a failure is never a flaky key generation. */
function keyProvider(version = 'projects/1/secrets/credkey/versions/1', key = randomBytes(32)): KeyProvider {
  return { resolve: async (): Promise<ResolvedKey> => ({ key, version }) };
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
    const [iv, data, tag] = record.oneTimePasswordCiphertext.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 0xff;
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

  /**
   * GAP. The criterion asks that a rotated key still decrypt in-flight
   * ciphertext, or that a drain procedure apply. Neither holds today:
   * retrieveOnce resolves the CURRENT key and ignores the keyVersion it wrote,
   * so a rotation while a handoff is outstanding makes that password
   * unrecoverable, and no drain procedure exists in the code.
   *
   * Written as it.fails so the gap is pinned rather than described: this test
   * starts failing the moment retrieveOnce becomes version-aware, which is the
   * signal to delete this comment and turn it into a normal test.
   */
  it.fails('GAP: ciphertext written under a previous key version survives a rotation', async () => {
    const v1 = randomBytes(32);
    const writer = new CredentialStore(fake as never, keyProvider('versions/1', v1));
    await writer.stash({ requestId: 'req-1', primaryEmail: 'ada@company.com', password: PASSWORD, ttlHours: 72 });

    // The key rotates while the handoff is still outstanding.
    const afterRotation = new CredentialStore(fake as never, keyProvider('versions/2', randomBytes(32)));

    await expect(afterRotation.retrieveOnce('req-1')).resolves.toEqual({
      primaryEmail: 'ada@company.com',
      password: PASSWORD,
    });
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
