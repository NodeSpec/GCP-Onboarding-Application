import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  credentialState,
  type AuditActor,
  type CredentialHandoff,
  type CredentialState,
} from './model.js';
import { appendAuditEvent } from './store.js';

/**
 * Protects the one-time password between generation and operator retrieval.
 *
 * Lives in the shared package rather than inside either service because both
 * ends of the handoff need it: the worker seals a generated password, and the
 * API service is where an operator retrieves it (REQ-017). A copy in each would
 * have been two implementations of one ciphertext format.
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
 * There is no credential left to hand over: none was ever stored, or the stored
 * one has been retrieved, has expired, or was superseded by a regeneration.
 *
 * Typed rather than a bare Error because it is the one failure a resend is
 * expected to hit on an ordinary day, and the remedy is specific: regenerate.
 * The executor classifies it as terminal, so the request stops here instead of
 * burning its retry budget on a condition no retry can change (REQ-030 AC-3).
 */
export class CredentialUnavailableError extends Error {
  constructor(
    readonly primaryEmail: string,
    readonly state: CredentialState | 'missing',
  ) {
    super(
      `No usable one-time password is stored for ${primaryEmail} (${state}). ` +
        'Resend with regenerate=true to set a fresh password, which resets the ' +
        "account holder's sign-in.",
    );
    this.name = 'CredentialUnavailableError';
  }
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

/** Injectable so rotation behaviour can be exercised without a GCP project. */
export interface SecretAccessor {
  accessSecretVersion(request: { name: string }): Promise<[{ name?: string | null; payload?: { data?: unknown } | null }, ...unknown[]]>;
}

export interface KeyProviderOptions {
  accessor?: SecretAccessor;
  /**
   * How long a resolution of `latest` may be reused, in milliseconds.
   *
   * NOT unbounded, and that is the whole point of this option existing
   * (REQ-014 AC-6). See the note on `access` below.
   */
  latestTtlMs?: number;
  now?: () => number;
}

/**
 * Ten minutes. Long enough that the hot path is not a Secret Manager call,
 * short enough to be irrelevant beside the 72 hour rotation drain window the
 * runbook prescribes.
 */
const LATEST_TTL_MS = 10 * 60 * 1000;

/** Reads the key from Secret Manager, base64 encoded, latest version. */
export class SecretManagerKeyProvider implements KeyProvider {
  private readonly secrets: SecretAccessor;
  private readonly latestTtlMs: number;
  private readonly now: () => number;
  /**
   * Keyed by version resource name, plus 'latest'. A single cached key was
   * enough while only the current version was ever read; decrypting historic
   * ciphertext means several versions can be live at once on one instance.
   * Bounded in practice by how many rotations a short-lived Cloud Run instance
   * can span, which is one or two.
   */
  private readonly cache = new Map<string, { resolved: ResolvedKey; expiresAt: number }>();

  /**
   * The secret resource name is passed in rather than read from a module-level
   * config. Both services hold this value under their own configuration, and
   * reaching into either one from here would have tied the shared package to
   * whichever service happened to be importing it.
   */
  constructor(
    private readonly secretName: string,
    options: KeyProviderOptions = {},
  ) {
    this.secrets = options.accessor ?? (new SecretManagerServiceClient() as unknown as SecretAccessor);
    this.latestTtlMs = options.latestTtlMs ?? LATEST_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async resolve(): Promise<ResolvedKey> {
    return this.access('latest');
  }

  async resolveVersion(version: string): Promise<ResolvedKey> {
    // Records written before the key version was captured carry 'unknown'.
    // Falling back to latest is the best available guess and still succeeds
    // whenever no rotation has happened since.
    if (!version || version === 'unknown') return this.resolve();
    return this.access(version);
  }

  /**
   * A CONCRETE version is immutable, so it is cached forever. `latest` is a
   * moving pointer and expires (REQ-014 AC-6).
   *
   * The difference is not a performance nicety, it is a correctness one. A
   * warm instance holding `latest` indefinitely keeps encrypting under the key
   * it read at startup and STAMPING NEW RECORDS WITH THAT VERSION. Follow the
   * runbook's rotation, which disables the previous version after the drain
   * window, and those records name a disabled version: the ciphertext is
   * intact and no longer decryptable, so the operator can never retrieve the
   * password and the failure surfaces long after the rotation that caused it.
   *
   * Bounding the pointer's lifetime is what keeps the drain window meaningful.
   */
  private async access(versionRef: string): Promise<ResolvedKey> {
    const cached = this.cache.get(versionRef);
    if (cached && cached.expiresAt > this.now()) return cached.resolved;

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

    this.cache.set(versionRef, {
      resolved,
      expiresAt: versionRef === 'latest' ? this.now() + this.latestTtlMs : Infinity,
    });
    // Also cache under the concrete version, so a later read of the same
    // version resolved through 'latest' does not re-fetch. Immutable, so no
    // expiry: version N's material is version N's material forever.
    if (version.name) this.cache.set(version.name, { resolved, expiresAt: Infinity });
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
    private readonly keys: KeyProvider,
  ) {}

  private handoffRef(requestId: string) {
    return this.db.collection(COLLECTIONS.credentialHandoffs).doc(requestId);
  }

  /**
   * Encrypts a password and returns the record to store, WITHOUT writing it.
   *
   * Split out from `stash` for regeneration (REQ-030 AC-4), where the new
   * ciphertext, the invalidation of the record it supersedes, and the audit
   * event all have to land in one transaction. Crypto cannot happen inside a
   * Firestore transaction handler that may be retried, so sealing happens first
   * and the store commits the result.
   */
  async seal(params: {
    primaryEmail: string;
    password: string;
    ttlHours: number;
  }): Promise<CredentialHandoff> {
    const { key, version } = await this.keys.resolve();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(params.password, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      primaryEmail: params.primaryEmail,
      // iv.ciphertext.tag, each base64url. Self describing, so a rotation or an
      // algorithm change can be detected rather than guessed at.
      oneTimePasswordCiphertext: [iv, encrypted, authTag]
        .map((part) => part.toString('base64url'))
        .join('.'),
      keyVersion: version,
      retrievedAt: null,
      expiresAt: Timestamp.fromMillis(Date.now() + params.ttlHours * 3_600_000),
      supersededAt: null,
      supersededBy: null,
    };
  }

  /**
   * The credential a resend would reuse: the newest record for this address
   * that can still be handed over (REQ-030 AC-3).
   *
   * An equality query on primaryEmail only, deliberately. Adding an orderBy
   * would need a composite index for a collection holding a handful of
   * documents per user, so the ordering is done here instead.
   */
  async currentFor(
    primaryEmail: string,
    now: number = Date.now(),
  ): Promise<{ requestId: string; record: CredentialHandoff } | null> {
    const snap = await this.db
      .collection(COLLECTIONS.credentialHandoffs)
      .where('primaryEmail', '==', primaryEmail.toLowerCase())
      .get();

    const usable = snap.docs
      .map((doc) => ({ requestId: doc.id, record: doc.data() as CredentialHandoff }))
      .filter(({ record }) => credentialState(record, now) === 'valid')
      .sort((a, b) => b.record.expiresAt.toMillis() - a.record.expiresAt.toMillis());

    return usable[0] ?? null;
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
    const record = await this.seal({
      primaryEmail: params.primaryEmail,
      password: params.password,
      ttlHours: params.ttlHours,
    });

    await this.handoffRef(params.requestId).set(record);
  }

  /**
   * Decrypts once and destroys the ciphertext in the same transaction, so two
   * concurrent retrievals yield exactly one success (REQ-017).
   *
   * Returns null when there is nothing to give: no record, already retrieved,
   * expired, or superseded by a regeneration. The caller maps that to 410;
   * distinguishing them would tell an unauthorised caller more than they should
   * learn.
   *
   * When `audit` is supplied, the event naming the operator who took the
   * credential is written INSIDE the claim transaction (REQ-017 AC-6). That is
   * the only ordering that works: an audit written afterwards would be lost by
   * a crash that had already destroyed the ciphertext, leaving a credential
   * gone with no record of who has it. Refusals carry no state change and are
   * audited by the caller, which is what recordDenied exists for.
   */
  async retrieveOnce(
    requestId: string,
    audit?: { actor: AuditActor; targetUser?: string },
  ): Promise<{ primaryEmail: string; password: string } | null> {
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
      // One predicate for "can this still be handed over", shared with the
      // resend precondition. A regeneration supersedes this record, and a
      // superseded record must not yield a password an operator would then hand
      // over believing it still signs in (REQ-030 AC-5).
      const state = credentialState(record, Date.now());
      if (state !== 'valid') {
        // An expired record has no further use, and leaving readable ciphertext
        // sitting behind a TTL that has already passed is exactly the exposure
        // the TTL exists to end. Destroy it on the way past, in this same
        // transaction, rather than waiting for a sweep that does not exist
        // (REQ-017 AC-4). Superseded and retrieved records are already empty.
        if (state === 'expired' && record.oneTimePasswordCiphertext !== '') {
          tx.update(ref, { oneTimePasswordCiphertext: '' });
          if (audit) {
            appendAuditEvent(this.db, tx, requestId, null, {
              actor: audit.actor,
              action: 'credential.expired',
              targetUser: audit.targetUser ?? record.primaryEmail,
              after: { state },
              outcome: 'failure',
            });
          }
        }
        return null;
      }

      tx.update(ref, {
        retrievedAt: Timestamp.now(),
        // Destroy the ciphertext rather than merely flagging the record. A flag
        // left alongside readable ciphertext is one bug away from a second read.
        oneTimePasswordCiphertext: '',
      });

      if (audit) {
        // Same transaction as the destruction. The event says WHO took it and
        // WHEN, and deliberately nothing about what they got: an audit trail is
        // not a second copy of the credential (REQ-017 AC-5, AC-6).
        appendAuditEvent(this.db, tx, requestId, null, {
          actor: audit.actor,
          action: 'credential.retrieved',
          targetUser: audit.targetUser ?? record.primaryEmail,
          after: { keyVersion: record.keyVersion },
        });
      }

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
