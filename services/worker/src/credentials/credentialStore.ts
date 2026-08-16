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
  resolve(): Promise<ResolvedKey>;
}

/** Reads the key from Secret Manager, base64 encoded, latest version. */
export class SecretManagerKeyProvider implements KeyProvider {
  private readonly secrets = new SecretManagerServiceClient();
  private cached: ResolvedKey | undefined;

  constructor(private readonly secretName: string = config.CREDENTIAL_KEY_SECRET) {}

  async resolve(): Promise<ResolvedKey> {
    // Cached for the instance lifetime. A rotation is picked up when Cloud Run
    // replaces the instance, or on the next cold start, without a redeploy.
    if (this.cached) return this.cached;

    const [version] = await this.secrets.accessSecretVersion({
      name: `${this.secretName}/versions/latest`,
    });

    const material = version.payload?.data;
    if (!material) throw new Error(`Secret ${this.secretName} has no payload`);

    const key = Buffer.from(material.toString(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Credential encryption key must be ${KEY_BYTES} bytes for ${ALGORITHM}, got ${key.length}. ` +
          'Store it base64 encoded.',
      );
    }

    this.cached = { key, version: version.name ?? 'unknown' };
    return this.cached;
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
    const { key } = await this.keys.resolve();

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

      return { ciphertext: record.oneTimePasswordCiphertext, primaryEmail: record.primaryEmail };
    });

    if (!claimed) return null;

    const parts = unpack(claimed.ciphertext);
    if (!parts) throw new Error(`Credential record for ${requestId} is malformed`);

    const decipher = createDecipheriv(ALGORITHM, key, parts.iv);
    decipher.setAuthTag(parts.tag);

    const plaintext = Buffer.concat([decipher.update(parts.data), decipher.final()]).toString('utf8');

    return { primaryEmail: claimed.primaryEmail, password: plaintext };
  }
}
