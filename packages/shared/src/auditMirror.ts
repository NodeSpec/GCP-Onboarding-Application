import { Firestore, Timestamp } from '@google-cloud/firestore';
import { COLLECTIONS, type AuditEvent } from './model.js';

/**
 * The audit trail's second copy, and the check that the two copies agree
 * (REQ-018 AC-1, AC-2).
 *
 * WHY A SECOND COPY EXISTS. REQ-010's append-only discipline is enforced in
 * this package: nothing here updates or deletes an audit document. That is a
 * property of the code, not of the data, and all Firestore access is through
 * Admin SDK credentials which bypass security rules entirely. Anyone who can
 * run code as either runtime identity can delete an audit document, and
 * Firestore IAM is database-scoped so it cannot be narrowed to stop them.
 * Tamper-evidence therefore has to come from a store the application identities
 * cannot rewrite: a Cloud Logging bucket with a locked retention policy
 * (REQ-018 AC-3 to AC-5, which are Terraform and IAM, not code).
 *
 * WHY A SWEEP RATHER THAN AN INLINE WRITE. Every audit event is written inside
 * the Firestore transaction that performs the change it records (REQ-016 AC-4),
 * and a Cloud Logging write cannot join that transaction. Mirroring from inside
 * the transaction body would mirror events from attempts that then aborted and
 * retried — Firestore retries transactions, and each attempt mints a fresh
 * eventId — so the log would accumulate ids that never existed in Firestore and
 * every reconciliation would report them forever. Reading committed events back
 * and mirroring those is the only way to mirror exactly what happened.
 *
 * THE COST, STATED. There is a window between an event committing and the sweep
 * carrying it across, and an event deleted inside that window reaches neither
 * store and is undetectable. The window is the sweep interval, so it is worth
 * keeping short. This is the honest limit of the control: it makes deletion of
 * anything older than one sweep evident, not deletion of anything at all.
 */

/** The mirrored shape. `insertId` is the eventId, so a replay is a no-op. */
export interface MirroredEvent {
  insertId: string;
  timestamp: Date;
  payload: Record<string, unknown>;
}

/**
 * The log side of the mirror, kept behind an interface so the sweep and the
 * reconciliation can be exercised without a project, and so a deployment that
 * routes its audit log somewhere else changes one class.
 */
export interface AuditLogWriter {
  write(entries: MirroredEvent[]): Promise<void>;
  /** The insertIds already present in the log over a window, for AC-2. */
  insertIdsBetween(from: Date, to: Date): Promise<Set<string>>;
}

/** Where the sweep got to. One document, so a restart resumes rather than replays. */
const PROGRESS_DOC = 'auditMirror';

interface Progress {
  /** Exclusive lower bound for the next sweep. */
  through: Timestamp;
  /**
   * The ids already mirrored AT exactly `through`. Firestore timestamps are
   * microsecond-precision but not unique, so a bound alone either re-mirrors
   * or skips events sharing the boundary instant. Re-mirroring is harmless
   * (insertId dedupes) but skipping is not, so the boundary is carried
   * explicitly and the bound is inclusive.
   */
  mirroredAt: string[];
  updatedAt: Timestamp;
}

/** Everything an auditor needs from a mirrored event, and nothing more. */
export function toMirroredEvent(event: AuditEvent): MirroredEvent {
  return {
    insertId: event.eventId,
    timestamp: event.timestamp.toDate(),
    payload: {
      eventId: event.eventId,
      requestId: event.requestId,
      stepId: event.stepId,
      actor: event.actor,
      action: event.action,
      targetUser: event.targetUser,
      before: event.before,
      after: event.after,
      outcome: event.outcome,
      timestamp: event.timestamp.toDate().toISOString(),
    },
  };
}

export interface SweepResult {
  mirrored: number;
  /** The events carried across, so a caller can log or assert on them. */
  eventIds: string[];
  /** Whether more remain beyond this batch's limit. */
  more: boolean;
}

export class AuditMirror {
  constructor(
    private readonly db: Firestore,
    private readonly writer: AuditLogWriter,
    private readonly options: { batchSize?: number } = {},
  ) {}

  private progressRef() {
    return this.db.collection(COLLECTIONS.audit).doc(`_${PROGRESS_DOC}`);
  }

  private async readProgress(): Promise<Progress | null> {
    const snap = await this.progressRef().get();
    return snap.exists ? (snap.data() as Progress) : null;
  }

  /**
   * Carries every committed audit event since the watermark into the log.
   *
   * ORDERING. The log write happens BEFORE the watermark advances. The reverse
   * would lose events on a crash between the two: the watermark would say they
   * were mirrored and nothing would ever go back for them. This way a crash
   * re-mirrors, which the insertId makes free.
   */
  async sweep(): Promise<SweepResult> {
    const batchSize = this.options.batchSize ?? 500;
    const progress = await this.readProgress();

    let query = this.db
      .collection(COLLECTIONS.audit)
      .orderBy('timestamp', 'asc')
      .limit(batchSize + 1);

    if (progress) query = query.startAt(progress.through);

    const snap = await query.get();
    const boundary = new Set(progress?.mirroredAt ?? []);

    const all = snap.docs
      // The progress document lives in this collection and is not an audit
      // event. Filtering on the field rather than the id keeps this correct if
      // another bookkeeping document is ever added.
      .map((doc) => doc.data() as Partial<AuditEvent>)
      .filter((data): data is AuditEvent => typeof data.eventId === 'string');

    const more = all.length > batchSize;
    const batch = more ? all.slice(0, batchSize) : all;
    const fresh = batch.filter((event) => !boundary.has(event.eventId));

    if (fresh.length === 0) return { mirrored: 0, eventIds: [], more };

    await this.writer.write(fresh.map(toMirroredEvent));

    const last = batch[batch.length - 1]!.timestamp;
    await this.progressRef().set({
      through: last,
      // Only the ids sharing the new boundary instant need carrying; the rest
      // are excluded by the bound itself.
      mirroredAt: batch
        .filter((event) => event.timestamp.isEqual(last))
        .map((event) => event.eventId),
      updatedAt: Timestamp.now(),
    } satisfies Progress);

    return { mirrored: fresh.length, eventIds: fresh.map((e) => e.eventId), more };
  }
}

export interface AuditReconciliation {
  from: Date;
  to: Date;
  checked: number;
  /** Committed in Firestore, absent from the log: the mirror is behind, or broken. */
  missingFromLog: string[];
  /**
   * In the log, absent from Firestore. Either a Firestore audit document was
   * deleted — which is the condition this whole control exists to make evident
   * — or the mirror wrote something that never committed.
   */
  missingFromFirestore: string[];
  agrees: boolean;
}

/**
 * Compares the two copies over a window (AC-2).
 *
 * Reports BOTH directions, because they mean opposite things. Missing from the
 * log is the mirror failing to keep up, which is an operational problem.
 * Missing from Firestore is an audit record that no longer exists in the store
 * the application can write to, which is the tamper signal.
 */
export async function reconcileAudit(
  db: Firestore,
  writer: AuditLogWriter,
  window: { from: Date; to: Date },
): Promise<AuditReconciliation> {
  const snap = await db
    .collection(COLLECTIONS.audit)
    .where('timestamp', '>=', Timestamp.fromDate(window.from))
    .where('timestamp', '<=', Timestamp.fromDate(window.to))
    .get();

  const inFirestore = new Set(
    snap.docs
      .map((doc) => doc.data() as Partial<AuditEvent>)
      .filter((data): data is AuditEvent => typeof data.eventId === 'string')
      .map((event) => event.eventId),
  );

  const inLog = await writer.insertIdsBetween(window.from, window.to);

  const missingFromLog = [...inFirestore].filter((id) => !inLog.has(id)).sort();
  const missingFromFirestore = [...inLog].filter((id) => !inFirestore.has(id)).sort();

  return {
    from: window.from,
    to: window.to,
    checked: inFirestore.size,
    missingFromLog,
    missingFromFirestore,
    agrees: missingFromLog.length === 0 && missingFromFirestore.length === 0,
  };
}
