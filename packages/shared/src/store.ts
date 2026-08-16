import { Firestore, Timestamp, type Transaction } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import {
  COLLECTIONS,
  type AuditActor,
  type AuditEvent,
  type LifecycleRequest,
  type LifecycleStep,
  type RequestStatus,
  type StepStatus,
} from './model.js';
import { assertRequestTransition, assertStepTransition } from './transitions.js';

/**
 * The data access layer for lifecycle state and audit.
 *
 * Two properties are enforced here rather than left to callers.
 *
 * 1. A state change and its audit event are written in ONE transaction. There
 *    is no exported way to move a status without describing why, and no
 *    exported way to write an audit event on its own. A change therefore cannot
 *    exist without its record, in either direction (REQ-010, REQ-016).
 *
 * 2. The audit collection is append only. This module exports no update and no
 *    delete for it, deliberately. Note that this is the ONLY real enforcement:
 *    Firestore security rules do not apply, because all access here is
 *    server-side through Admin SDK credentials which bypass rules entirely, and
 *    Firestore IAM is database-scoped rather than per-collection. Tamper
 *    evidence comes from the Cloud Logging mirror with a locked retention
 *    policy (REQ-018), not from this file. Do not add a delete helper because
 *    a test fixture wants one.
 */

export interface AuditInput {
  actor: AuditActor;
  action: string;
  targetUser?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  outcome?: 'success' | 'failure' | 'denied';
}

export class LifecycleStore {
  constructor(private readonly db: Firestore) {}

  requestRef(requestId: string) {
    return this.db.collection(COLLECTIONS.requests).doc(requestId);
  }

  stepRef(requestId: string, stepId: string) {
    return this.requestRef(requestId).collection(COLLECTIONS.steps).doc(stepId);
  }

  async getRequest(requestId: string): Promise<LifecycleRequest | null> {
    const snap = await this.requestRef(requestId).get();
    return snap.exists ? (snap.data() as LifecycleRequest) : null;
  }

  /** Steps in execution order, for the operator timeline. */
  async listSteps(requestId: string): Promise<LifecycleStep[]> {
    const snap = await this.requestRef(requestId)
      .collection(COLLECTIONS.steps)
      .orderBy('ordinal', 'asc')
      .get();
    return snap.docs.map((doc) => doc.data() as LifecycleStep);
  }

  /** Audit history for one request, oldest first. */
  async listAudit(requestId: string): Promise<AuditEvent[]> {
    const snap = await this.db
      .collection(COLLECTIONS.audit)
      .where('requestId', '==', requestId)
      .orderBy('timestamp', 'asc')
      .get();
    return snap.docs.map((doc) => doc.data() as AuditEvent);
  }

  /**
   * The only way to write an audit event. Private to this module and always
   * called from a transition, so an audit event cannot be written without the
   * change it describes.
   */
  private appendAudit(
    tx: Transaction,
    requestId: string,
    stepId: string | null,
    input: AuditInput,
  ): AuditEvent {
    const event: AuditEvent = {
      eventId: randomUUID(),
      requestId,
      stepId,
      actor: input.actor,
      action: input.action,
      targetUser: input.targetUser ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      outcome: input.outcome ?? 'success',
      timestamp: Timestamp.now(),
    };
    tx.create(this.db.collection(COLLECTIONS.audit).doc(event.eventId), event);
    return event;
  }

  /**
   * Move a step, guarded, with its audit event, in one transaction.
   *
   * `expectedFrom` is the concurrency control. The current status is re-read
   * inside the transaction and compared, so a redelivered task that lost the
   * race observes the newer status and gets `applied: false` rather than
   * executing a second time.
   */
  async transitionStep(params: {
    requestId: string;
    stepId: string;
    expectedFrom: StepStatus | StepStatus[];
    to: StepStatus;
    audit: AuditInput;
    patch?: Partial<LifecycleStep>;
  }): Promise<{ applied: boolean; observed: StepStatus }> {
    const expected = Array.isArray(params.expectedFrom)
      ? params.expectedFrom
      : [params.expectedFrom];

    return this.db.runTransaction(async (tx) => {
      const ref = this.stepRef(params.requestId, params.stepId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(`Step ${params.stepId} not found on request ${params.requestId}`);
      }

      const current = snap.data() as LifecycleStep;

      // Lost the race, or a duplicate delivery. Not an error: the work is done.
      if (!expected.includes(current.status)) {
        return { applied: false, observed: current.status };
      }

      assertStepTransition(params.stepId, current.status, params.to);

      tx.update(ref, {
        ...params.patch,
        status: params.to,
        ...(params.to === 'running' ? { startedAt: Timestamp.now() } : {}),
        ...(params.to === 'succeeded' || params.to === 'failed' || params.to === 'skipped'
          ? { completedAt: Timestamp.now() }
          : {}),
      });

      this.appendAudit(tx, params.requestId, params.stepId, {
        ...params.audit,
        before: { status: current.status },
        after: { status: params.to },
      });

      return { applied: true, observed: current.status };
    });
  }

  /** Move a request, guarded, with its audit event, in one transaction. */
  async transitionRequest(params: {
    requestId: string;
    expectedFrom: RequestStatus | RequestStatus[];
    to: RequestStatus;
    audit: AuditInput;
    patch?: Partial<LifecycleRequest>;
  }): Promise<{ applied: boolean; observed: RequestStatus }> {
    const expected = Array.isArray(params.expectedFrom)
      ? params.expectedFrom
      : [params.expectedFrom];

    return this.db.runTransaction(async (tx) => {
      const ref = this.requestRef(params.requestId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error(`Request ${params.requestId} not found`);

      const current = snap.data() as LifecycleRequest;
      if (!expected.includes(current.status)) {
        return { applied: false, observed: current.status };
      }

      assertRequestTransition(params.requestId, current.status, params.to);

      tx.update(ref, { ...params.patch, status: params.to, updatedAt: Timestamp.now() });

      this.appendAudit(tx, params.requestId, null, {
        ...params.audit,
        before: { status: current.status },
        after: { status: params.to },
      });

      return { applied: true, observed: current.status };
    });
  }

  /**
   * Records an authorisation refusal. These carry no state change, so this is
   * the one audit path with nothing to pair with. It is a create-only write to
   * the audit collection and still exposes no update or delete.
   */
  async recordDenied(params: {
    requestId: string;
    stepId?: string | null;
    actor: AuditActor;
    action: string;
    reason: string;
  }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      this.appendAudit(tx, params.requestId, params.stepId ?? null, {
        actor: params.actor,
        action: params.action,
        after: { reason: params.reason },
        outcome: 'denied',
      });
    });
  }
}
