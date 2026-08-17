import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { COLLECTIONS, type CredentialHandoff } from '@lifecycle/shared';
import { config } from '../config.js';

/**
 * Protects the one-time password between generation and operator retrieval.
 *
 * ENCRYPTED, not hashed. This is the decision most likely to be "corrected" by
 * someone applying the usual rule that passwords are hashed. That rule is about
 * verifying a value someone presents. Here the operator has to recover the real
 * password to hand it over, and a hash cannot be reversed. Hashing this field
 * would make the split-channel handoff impossible.
 *
 * AES-256-GCM with a random IV per record and the key version recorded
 * alongside, so ciphertext written under a previous key version stays readable
 * across a rotation (REQ-019, REQ-022).
 *
 * Secret access is behind an interface so tests can supply a fixed key without
 * reaching Secret Manager. Without that seam the encrypt/decrypt round trip,
 * which is the whole point of this file, could only be exercised against real
 * infrastructure.
 *
 * Serves REQ-019.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface ResolvedKey {
  key: Buffer;
  version: string;
}

/** Resolves the data-encryption key. Swapped for a fixture in tests. */
export interface KeyProvider {
  /** The current key, for writes. */
  resolve(): Promise<ResolvedKey>;
  /**
   * A specific key version, for reads. Ciphertext must be decrypted under the
   * key it was written with, not whatever is current, or a rotation makes every
   * outstanding handoff unrecoverable (REQ-019 AC-3).
   */
  resolveVersion(version: string): Promise<ResolvedKey>;
}

/**
 * The credential was written under a key version that can no longer be read,
 * which in practice means the version was destroyed. Typed and specific,
 * because a raw GCM auth-tag failure looks like data corruption and gets
 * escalated as one; this tells the operator what actually happened and that the
 * recovery is regeneration (REQ-030).
 */
export class CredentialUnrecoverableError extends Error {
  constructor(
    readonly requestId: string,
    readonly keyVersion: string,
    options?: { cause?: unknown },
  ) {
    super(
      `The one-time password for ${requestId} was encrypted under key version ${keyVersion}, ` +
        'which is no longer accessible. This is expected after an emergency key rotation that ' +
        'destroyed the old version. Regenerate the credential rather than treating this as corruption.',
      options,
    );
    this.name = 'CredentialUnrecoverableError';
  }
}

/** Reads the key from Secret Manager, base64 encoded, latest version. */
export class SecretManagerKeyProvider implements KeyProvider {
  private readonly secrets = new SecretManagerServiceClient();
  /**
   * Keyed by version resource name, plus 'latest'. A single cached key was
   * enough while only the current version was ever read; decrypting historic
   * ciphertext means several versions can be live at once on one instance.
   * Bounded in practice by how many rotations a short-lived Cloud Run instance
   * can span, which is one or two.
   */
  private readonly cache = new Map<string, ResolvedKey>();

  constructor(private readonly secretName: string = config.CREDENTIAL_KEY_SECRET) {}

  async resolve(): Promise<ResolvedKey> {
    // Cached for the instance lifetime. A rotation is picked up when Cloud Run
    // replaces the instance, or on the next cold start, without a redeploy.
    return this.access('latest');
  }

  async resolveVersion(version: string): Promise<ResolvedKey> {
    // Records written before the key version was captured carry 'unknown'.
    // Falling back to latest is the best available guess and still succeeds
    // whenever no rotation has happened since.
    if (!version || version === 'unknown') return this.resolve();
    return this.access(version);
  }

  private async access(versionRef: string): Promise<ResolvedKey> {
    const cached = this.cache.get(versionRef);
    if (cached) return cached;

    // A bare 'latest' needs the secret prefix; a recorded version is already a
    // full resource name.
    const name = versionRef === 'latest' ? `${this.secretName}/versions/latest` : versionRef;
    const [version] = await this.secrets.accessSecretVersion({ name });

    const material = version.payload?.data;
    if (!material) throw new Error(`Secret ${name} has no payload`);

    const key = Buffer.from(material.toString(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Credential encryption key must be ${KEY_BYTES} bytes for ${ALGORITHM}, got ${key.length}. ` +
          'Store it base64 encoded.',
      );
    }

    const resolved: ResolvedKey = { key, version: version.name ?? 'unknown' };
    this.cache.set(versionRef, resolved);
    // Also cache under the concrete version, so a later read of the same
    // version resolved through 'latest' does not re-fetch.
    if (version.name) this.cache.set(version.name, resolved);
    return resolved;
  }
}

/** Splits an encoded record into its parts, or null if it is malformed. */
export function unpack(packed: string): { iv: Buffer; data: Buffer; tag: Buffer } | null {
  const parts = packed.split('.');
  if (parts.length !== 3) return null;
  const [ivPart, dataPart, tagPart] = parts;
  if (!ivPart || !dataPart || !tagPart) return null;
  return {
    iv: Buffer.from(ivPart, 'base64url'),
    data: Buffer.from(dataPart, 'base64url'),
    tag: Buffer.from(tagPart, 'base64url'),
  };
}

export class CredentialStore {
  constructor(
    private readonly db: Firestore,
    private readonly keys: KeyProvider = new SecretManagerKeyProvider(),
  ) {}

  private handoffRef(requestId: string) {
    return this.db.collection(COLLECTIONS.credentialHandoffs).doc(requestId);
  }

  /**
   * Encrypts and stores. The caller is expected to drop its reference to the
   * plaintext immediately after this resolves; nothing here retains it.
   */
  async stash(params: {
    requestId: string;
    primaryEmail: string;
    password: string;
    ttlHours: number;
  }): Promise<void> {
    const { key, version } = await this.keys.resolve();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(params.password, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // iv.ciphertext.tag, each base64url. Self describing, so a rotation or an
    // algorithm change can be detected rather than guessed at.
    const packed = [iv, encrypted, authTag].map((part) => part.toString('base64url')).join('.');

    const record: CredentialHandoff = {
      primaryEmail: params.primaryEmail,
      oneTimePasswordCiphertext: packed,
      keyVersion: version,
      retrievedAt: null,
      expiresAt: Timestamp.fromMillis(Date.now() + params.ttlHours * 3_600_000),
    };

    await this.handoffRef(params.requestId).set(record);
  }

  /**
   * Decrypts once and destroys the ciphertext in the same transaction, so two
   * concurrent retrievals yield exactly one success (REQ-017).
   *
   * Returns null when there is nothing to give: no record, already retrieved,
   * or expired. The caller maps that to 410; distinguishing the three would
   * tell an unauthorised caller more than they should learn.
   */
  async retrieveOnce(requestId: string): Promise<{ primaryEmail: string; password: string } | null> {
    // Resolve the key BEFORE the claim transaction, not after.
    //
    // The claim destroys the ciphertext. If key resolution or decryption then
    // failed, the password would be gone AND unreadable, turning a recoverable
    // situation into a permanent loss. Reading the record first costs one extra
    // get and means an unresolvable key fails while the ciphertext is still
    // intact. The pre-read is not a substitute for the transaction: the claim
    // below is still what guarantees exactly one caller wins.
    const preRead = await this.handoffRef(requestId).get();
    if (!preRead.exists) return null;
    const recordedVersion = (preRead.data() as CredentialHandoff).keyVersion;

    let key: Buffer;
    try {
      ({ key } = await this.keys.resolveVersion(recordedVersion));
    } catch (err) {
      throw new CredentialUnrecoverableError(requestId, recordedVersion, { cause: err });
    }

    const claimed = await this.db.runTransaction(async (tx) => {
      const ref = this.handoffRef(requestId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;

      const record = snap.data() as CredentialHandoff;
      if (record.retrievedAt !== null) return null;
      if (record.expiresAt.toMillis() <= Date.now()) return null;

      tx.update(ref, {
        retrievedAt: Timestamp.now(),
        // Destroy the ciphertext rather than merely flagging the record. A flag
        // left alongside readable ciphertext is one bug away from a second read.
        oneTimePasswordCiphertext: '',
      });

      return {
        ciphertext: record.oneTimePasswordCiphertext,
        primaryEmail: record.primaryEmail,
        keyVersion: record.keyVersion,
      };
    });

    if (!claimed) return null;

    // The record could have been rewritten between the pre-read and the claim.
    // Vanishingly unlikely, but decrypting with the wrong key would produce an
    // auth-tag failure that reads as corruption, so re-resolve rather than
    // guess.
    if (claimed.keyVersion !== recordedVersion) {
      try {
        ({ key } = await this.keys.resolveVersion(claimed.keyVersion));
      } catch (err) {
        throw new CredentialUnrecoverableError(requestId, claimed.keyVersion, { cause: err });
      }
    }

    const parts = unpack(claimed.ciphertext);
    if (!parts) throw new Error(`Credential record for ${requestId} is malformed`);

    const decipher = createDecipheriv(ALGORITHM, key, parts.iv);
    decipher.setAuthTag(parts.tag);

    const plaintext = Buffer.concat([decipher.update(parts.data), decipher.final()]).toString('utf8');

    return { primaryEmail: claimed.primaryEmail, password: plaintext };
  }
}
