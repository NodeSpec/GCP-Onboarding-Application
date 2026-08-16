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
 * Serves REQ-019.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

interface ResolvedKey {
  key: Buffer;
  version: string;
}

export class CredentialStore {
  private readonly secrets = new SecretManagerServiceClient();
  private cached: ResolvedKey | undefined;

  constructor(private readonly db: Firestore) {}

  /**
   * Resolves the data-encryption key. Cached in memory for the instance
   * lifetime; a rotation is picked up when Cloud Run replaces the instance, or
   * on the next cold start, without a redeploy.
   */
  private async resolveKey(): Promise<ResolvedKey> {
    if (this.cached) return this.cached;

    const [version] = await this.secrets.accessSecretVersion({
      name: `${config.CREDENTIAL_KEY_SECRET}/versions/latest`,
    });

    const material = version.payload?.data;
    if (!material) {
      throw new Error(`Secret ${config.CREDENTIAL_KEY_SECRET} has no payload`);
    }

    const key = Buffer.from(material.toString(), 'base64');
    if (key.length !== 32) {
      throw new Error(
        `Credential encryption key must be 32 bytes for ${ALGORITHM}, got ${key.length}. ` +
          'Store it base64 encoded.',
      );
    }

    this.cached = { key, version: version.name ?? 'unknown' };
    return this.cached;
  }

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
    const { key, version } = await this.resolveKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
      cipher.update(params.password, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // iv.ciphertext.tag, each base64url. Self describing, so a rotation or an
    // algorithm change can be detected rather than guessed at.
    const packed = [iv, encrypted, authTag].map((part) => part.toString('base64url')).join('.');

    const expiresAt = Timestamp.fromMillis(Date.now() + params.ttlHours * 3_600_000);

    const record: CredentialHandoff = {
      primaryEmail: params.primaryEmail,
      oneTimePasswordCiphertext: packed,
      keyVersion: version,
      retrievedAt: null,
      expiresAt,
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
    const { key } = await this.resolveKey();

    const packed = await this.db.runTransaction(async (tx) => {
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

    if (!packed) return null;

    const [ivPart, dataPart, tagPart] = packed.ciphertext.split('.');
    if (!ivPart || !dataPart || !tagPart) {
      throw new Error(`Credential record for ${requestId} is malformed`);
    }

    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');

    return { primaryEmail: packed.primaryEmail, password: plaintext };
  }
}
