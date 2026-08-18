import { Timestamp } from '@google-cloud/firestore';
import { emulatorDb, wipeAll } from '@lifecycle/test-support';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditMirror, reconcileAudit, type AuditLogWriter, type MirroredEvent } from './auditMirror.js';
import { COLLECTIONS, type AuditActor } from './model.js';
import { DEFAULT_POLICY } from './policy.js';
import { buildNewRequest } from './requestFactory.js';
import { stepPlanFor } from './stepPlans.js';
import { LifecycleStore } from './store.js';

/**
 * TC-REQ-018-1 and TC-REQ-018-2, against the Firestore emulator.
 *
 * Both criteria are about two stores agreeing, so both halves have to be real
 * on the side this code owns. The Firestore side is the emulator: the sweep is
 * an ordered range query over a collection whose timestamps are not unique, and
 * a fake would confirm the fake's ordering rather than Firestore's. The Cloud
 * Logging side is a recording double, because what is being asserted is what
 * this code sends and how it reconciles — not that Google's API accepts it.
 *
 * The remaining REQ-018 criteria (AC-3 to AC-5) are IAM and a locked retention
 * policy on the deployed bucket. No test in this repository can prove them and
 * none here pretends to.
 */

const db = emulatorDb();
const store = new LifecycleStore(db);
const wipe = () => wipeAll(db);

beforeAll(wipe);
afterEach(wipe);

const ACTOR: AuditActor = { kind: 'human', email: 'operator@company.com' };

/** A Cloud Logging stand-in that remembers everything it was given. */
function recordingLog() {
  const entries: MirroredEvent[] = [];
  let failNext = false;

  const writer: AuditLogWriter = {
    async write(batch) {
      if (failNext) {
        failNext = false;
        throw new Error('log write refused');
      }
      // Deduplicated on insertId, as Cloud Logging does.
      for (const entry of batch) {
        if (!entries.some((e) => e.insertId === entry.insertId)) entries.push(entry);
      }
    },
    async insertIdsBetween(from, to) {
      return new Set(
        entries
          .filter((e) => e.timestamp >= from && e.timestamp <= to)
          .map((e) => e.insertId),
      );
    },
  };

  return {
    writer,
    entries,
    ids: () => entries.map((e) => e.insertId),
    failOnce: () => {
      failNext = true;
    },
  };
}

const PAYLOAD = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  groups: ['engineering@company.com'],
};

/** Produces real audit events by doing real things through the store. */
async function makeRequest(targetUser = PAYLOAD.primaryEmail) {
  const payload = { ...PAYLOAD, primaryEmail: targetUser };
  const { request } = await store.createRequest(
    buildNewRequest({
      phase: 'create',
      targetUser,
      requestedBy: 'operator@company.com',
      payload,
      plan: stepPlanFor('create', payload),
      policy: DEFAULT_POLICY,
    }),
    ACTOR,
  );
  return request;
}

async function auditIds(): Promise<string[]> {
  const snap = await db.collection(COLLECTIONS.audit).get();
  return snap.docs
    .map((d) => d.data() as { eventId?: string })
    .filter((d): d is { eventId: string } => typeof d.eventId === 'string')
    .map((d) => d.eventId)
    .sort();
}

// --------------------------------------------------------------------- AC-1

describe('AC-1: every audit event reaches the log under the same eventId', () => {
  it('mirrors what committed, keyed on the eventId the Firestore copy carries', async () => {
    await makeRequest();
    await makeRequest('grace.hopper@company.com');

    const log = recordingLog();
    const result = await new AuditMirror(db, log.writer).sweep();

    const expected = await auditIds();
    expect(expected.length).toBeGreaterThan(0);
    // The join key. Reconciliation has nothing to match on without it.
    expect(log.ids().sort()).toEqual(expected);
    expect(result.mirrored).toBe(expected.length);
  });

  it('carries the whole event, so the log copy stands alone as a record', async () => {
    const request = await makeRequest();

    const log = recordingLog();
    await new AuditMirror(db, log.writer).sweep();

    const admission = log.entries.find(
      (e) => (e.payload as { requestId?: string }).requestId === request.requestId,
    );

    expect(admission).toBeDefined();
    expect(admission!.payload).toMatchObject({
      requestId: request.requestId,
      outcome: 'success',
      actor: { kind: 'human', email: 'operator@company.com' },
    });
    expect(typeof (admission!.payload as { action?: string }).action).toBe('string');
    // A log entry with no timestamp of its own cannot be reconciled by window.
    expect(admission!.timestamp).toBeInstanceOf(Date);
  });

  it('does not mirror the same event twice across sweeps', async () => {
    await makeRequest();

    const log = recordingLog();
    const mirror = new AuditMirror(db, log.writer);

    const first = await mirror.sweep();
    const second = await mirror.sweep();

    expect(first.mirrored).toBeGreaterThan(0);
    // The watermark held. Without the boundary-id carry, events sharing the
    // last timestamp would be re-sent on every sweep forever.
    expect(second.mirrored).toBe(0);
    expect(log.ids()).toHaveLength(first.mirrored);
  });

  it('picks up events written after a sweep', async () => {
    const log = recordingLog();
    const mirror = new AuditMirror(db, log.writer);

    await makeRequest();
    await mirror.sweep();
    const afterFirst = log.ids().length;

    await makeRequest('alan.turing@company.com');
    const second = await mirror.sweep();

    expect(second.mirrored).toBeGreaterThan(0);
    expect(log.ids().length).toBeGreaterThan(afterFirst);
    expect(log.ids().sort()).toEqual(await auditIds());
  });

  it('does not advance the watermark past a batch the log refused', async () => {
    // The ordering that matters. Advancing first would mark events mirrored
    // that never landed, and nothing would ever go back for them — a
    // permanent, silent hole in the second copy.
    await makeRequest();

    const log = recordingLog();
    const mirror = new AuditMirror(db, log.writer);

    log.failOnce();
    await expect(mirror.sweep()).rejects.toThrow('log write refused');
    expect(log.ids()).toEqual([]);

    const recovered = await mirror.sweep();
    expect(recovered.mirrored).toBeGreaterThan(0);
    expect(log.ids().sort()).toEqual(await auditIds());
  });

  it('respects the batch size and reports that more remain', async () => {
    await makeRequest();
    await makeRequest('grace.hopper@company.com');
    await makeRequest('alan.turing@company.com');

    const total = (await auditIds()).length;
    expect(total).toBeGreaterThan(2);

    const log = recordingLog();
    const mirror = new AuditMirror(db, log.writer, { batchSize: 2 });

    const first = await mirror.sweep();
    expect(first.mirrored).toBe(2);
    expect(first.more).toBe(true);

    // Draining is just sweeping again, so a large backlog needs no special path.
    let guard = 0;
    while ((await mirror.sweep()).more && guard++ < 20) {
      /* drain */
    }
    expect(log.ids().sort()).toEqual(await auditIds());
  });

  it('never mirrors its own progress document as an audit event', async () => {
    await makeRequest();

    const log = recordingLog();
    const mirror = new AuditMirror(db, log.writer);
    await mirror.sweep();
    await makeRequest('grace.hopper@company.com');
    await mirror.sweep();

    expect(log.ids().sort()).toEqual(await auditIds());
    expect(log.ids().some((id) => id.includes('auditMirror'))).toBe(false);
  });
});

// --------------------------------------------------------------------- AC-2

describe('AC-2: reconciliation reports either store missing an event', () => {
  const WINDOW = () => ({
    from: new Date(Date.now() - 60 * 60 * 1000),
    to: new Date(Date.now() + 60 * 60 * 1000),
  });

  it('agrees when the mirror is current', async () => {
    await makeRequest();

    const log = recordingLog();
    await new AuditMirror(db, log.writer).sweep();

    const report = await reconcileAudit(db, log.writer, WINDOW());

    expect(report.agrees).toBe(true);
    expect(report.checked).toBe((await auditIds()).length);
    expect(report.missingFromLog).toEqual([]);
    expect(report.missingFromFirestore).toEqual([]);
  });

  it('names the events Firestore holds and the log does not', async () => {
    // The mirror is behind, or broken. An operational problem, not a tamper
    // signal, and the report has to say which.
    await makeRequest();

    const log = recordingLog();
    const report = await reconcileAudit(db, log.writer, WINDOW());

    expect(report.agrees).toBe(false);
    expect(report.missingFromLog).toEqual(await auditIds());
    expect(report.missingFromFirestore).toEqual([]);
  });

  it('names an audit event that vanished from Firestore after being mirrored', async () => {
    // The condition this control exists for. Firestore audit documents are
    // append-only by discipline in this package, and that discipline is
    // bypassed by anything holding the Admin SDK credential. The log copy is
    // what makes the removal visible.
    await makeRequest();

    const log = recordingLog();
    await new AuditMirror(db, log.writer).sweep();

    const before = await auditIds();
    const victim = before[0]!;
    await db.collection(COLLECTIONS.audit).doc(victim).delete();

    const report = await reconcileAudit(db, log.writer, WINDOW());

    expect(report.agrees).toBe(false);
    expect(report.missingFromFirestore).toEqual([victim]);
    // And it is not confused for the other direction, which would have an
    // operator chasing the mirror instead of the deletion.
    expect(report.missingFromLog).toEqual([]);
  });

  it('reports both directions at once rather than stopping at the first', async () => {
    await makeRequest();

    const log = recordingLog();
    await new AuditMirror(db, log.writer).sweep();

    const mirrored = await auditIds();
    await db.collection(COLLECTIONS.audit).doc(mirrored[0]!).delete();
    // A later event that the sweep has not reached yet.
    await makeRequest('grace.hopper@company.com');

    const report = await reconcileAudit(db, log.writer, WINDOW());

    expect(report.missingFromFirestore).toEqual([mirrored[0]!]);
    expect(report.missingFromLog.length).toBeGreaterThan(0);
    expect(report.agrees).toBe(false);
  });

  it('checks only the window it was asked about', async () => {
    // A sample window, per the criterion. Reconciling the whole trail on every
    // run would grow without bound and eventually stop being run at all.
    await makeRequest();

    const log = recordingLog();
    await new AuditMirror(db, log.writer).sweep();

    const past = {
      from: new Date(Date.now() - 48 * 60 * 60 * 1000),
      to: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };
    const report = await reconcileAudit(db, log.writer, past);

    expect(report.checked).toBe(0);
    expect(report.agrees).toBe(true);
    expect(report.from).toEqual(past.from);
    expect(report.to).toEqual(past.to);
  });

  it('ignores the mirror progress document, which is not an audit event', async () => {
    await makeRequest();

    const log = recordingLog();
    await new AuditMirror(db, log.writer).sweep();

    // Present in the collection, written with a current timestamp, and not an
    // audit event. Counting it would make every reconciliation disagree.
    const progress = await db.collection(COLLECTIONS.audit).doc('_auditMirror').get();
    expect(progress.exists).toBe(true);
    expect((progress.data() as { updatedAt?: Timestamp }).updatedAt).toBeInstanceOf(Timestamp);

    const report = await reconcileAudit(db, log.writer, WINDOW());
    expect(report.agrees).toBe(true);
  });
});
