import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretManagerKeyProvider, type SecretAccessor } from './credentials.js';

/**
 * TC-REQ-014-6: rotating a secret version is picked up without a redeploy.
 *
 * The SMTP half of this criterion is REQ-028 AC-10, where a stale credential
 * announces itself with an authentication failure and the sender re-reads on
 * the spot. The credential encryption key has no such signal, and that absence
 * is what makes this worth testing rather than assuming.
 *
 * The failure mode it guards against is delayed and silent. A warm instance
 * that caches `latest` forever keeps encrypting under the key it read at
 * startup and STAMPS NEW RECORDS WITH THAT VERSION. Follow the runbook's
 * rotation, which disables the previous version after the 72 hour drain, and
 * those records name a disabled version: intact ciphertext that no longer
 * decrypts, discovered when an operator tries to hand over a password and
 * cannot. Nothing about that failure points back at the rotation days earlier.
 */

const SECRET = 'projects/p/secrets/credential-encryption-key';

/** A Secret Manager stand-in whose `latest` can be repointed, as a rotation does. */
function fakeSecrets() {
  const versions = new Map<string, Buffer>();
  const reads: string[] = [];
  let latest = '';

  const accessor: SecretAccessor = {
    async accessSecretVersion({ name }) {
      reads.push(name);
      const resolvedName = name.endsWith('/versions/latest') ? latest : name;
      const material = versions.get(resolvedName);
      if (!material) throw new Error(`no such version: ${resolvedName}`);
      return [{ name: resolvedName, payload: { data: material.toString('base64') } }];
    },
  };

  return {
    accessor,
    reads,
    /** Adds a version and points `latest` at it, as `secrets versions add` does. */
    rotate(n: number): string {
      const name = `${SECRET}/versions/${n}`;
      versions.set(name, randomBytes(32));
      latest = name;
      return name;
    },
    /** Disables a version, as the runbook's step 3 does after the drain. */
    disable(name: string): void {
      versions.delete(name);
    },
  };
}

describe('AC-6: a rotation is picked up without a redeploy', () => {
  it('keeps serving the cached key inside the TTL rather than reading per call', async () => {
    // The credential key is resolved on every credential write. Without a
    // cache each one is a Secret Manager round trip.
    const secrets = fakeSecrets();
    secrets.rotate(1);

    let now = 0;
    const provider = new SecretManagerKeyProvider(SECRET, {
      accessor: secrets.accessor,
      latestTtlMs: 60_000,
      now: () => now,
    });

    await provider.resolve();
    await provider.resolve();
    now += 59_000;
    await provider.resolve();

    expect(secrets.reads).toHaveLength(1);
  });

  it('picks up a new version once the TTL passes, with no restart', async () => {
    const secrets = fakeSecrets();
    const v1 = secrets.rotate(1);

    let now = 0;
    const provider = new SecretManagerKeyProvider(SECRET, {
      accessor: secrets.accessor,
      latestTtlMs: 60_000,
      now: () => now,
    });

    expect((await provider.resolve()).version).toBe(v1);

    // The operator adds a new version. The process keeps running.
    const v2 = secrets.rotate(2);
    now += 60_001;

    expect((await provider.resolve()).version).toBe(v2);
  });

  it('does not stamp new records with a version that is about to be disabled', async () => {
    // The whole point, played out in the runbook's order: rotate, drain,
    // disable. A provider that never re-read `latest` would still be writing
    // v1 at the end of this, and those records would be unreadable.
    const secrets = fakeSecrets();
    const v1 = secrets.rotate(1);

    let now = 0;
    const provider = new SecretManagerKeyProvider(SECRET, {
      accessor: secrets.accessor,
      latestTtlMs: 10 * 60 * 1000,
      now: () => now,
    });

    expect((await provider.resolve()).version).toBe(v1);

    const v2 = secrets.rotate(2);
    // Well inside the 72 hour drain the runbook prescribes.
    now += 11 * 60 * 1000;
    expect((await provider.resolve()).version).toBe(v2);

    // Drain elapses and the old version is disabled.
    now += 72 * 60 * 60 * 1000;
    secrets.disable(v1);

    // New records still resolve, under the live version.
    expect((await provider.resolve()).version).toBe(v2);
  });

  it('caches a concrete version forever, because a version’s material never changes', async () => {
    // The asymmetry that makes the TTL affordable. Historic ciphertext is
    // decrypted by recorded version, and re-reading those on a timer would put
    // a Secret Manager call in front of every retrieval for no benefit.
    const secrets = fakeSecrets();
    const v1 = secrets.rotate(1);

    let now = 0;
    const provider = new SecretManagerKeyProvider(SECRET, {
      accessor: secrets.accessor,
      latestTtlMs: 60_000,
      now: () => now,
    });

    await provider.resolveVersion(v1);
    now += 10 * 24 * 60 * 60 * 1000;
    await provider.resolveVersion(v1);

    expect(secrets.reads).toEqual([v1]);
  });

  it('still decrypts ciphertext written under the previous version during the drain', async () => {
    // REQ-019 AC-3 and the runbook's drain step, from this side. A record
    // written before the rotation names v1, and v1 is still enabled, so it
    // resolves.
    const secrets = fakeSecrets();
    const v1 = secrets.rotate(1);

    let now = 0;
    const provider = new SecretManagerKeyProvider(SECRET, {
      accessor: secrets.accessor,
      latestTtlMs: 60_000,
      now: () => now,
    });

    const written = await provider.resolve();
    expect(written.version).toBe(v1);

    secrets.rotate(2);
    now += 60_001;

    const recovered = await provider.resolveVersion(v1);
    expect(recovered.version).toBe(v1);
    expect(recovered.key.equals(written.key)).toBe(true);
  });

  it('resolves a record carrying no recorded version through latest', async () => {
    // Records written before the version was captured carry 'unknown'.
    const secrets = fakeSecrets();
    const v1 = secrets.rotate(1);

    const provider = new SecretManagerKeyProvider(SECRET, { accessor: secrets.accessor });

    expect((await provider.resolveVersion('unknown')).version).toBe(v1);
    expect((await provider.resolveVersion('')).version).toBe(v1);
  });

  it('rejects key material of the wrong length rather than encrypting with it', async () => {
    const accessor: SecretAccessor = {
      async accessSecretVersion({ name }) {
        return [{ name, payload: { data: Buffer.from('too short').toString('base64') } }];
      },
    };

    const provider = new SecretManagerKeyProvider(SECRET, { accessor });

    await expect(provider.resolve()).rejects.toThrow(/must be 32 bytes/);
  });
});
