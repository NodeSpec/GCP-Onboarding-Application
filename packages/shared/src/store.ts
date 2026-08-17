import { Firestore, Timestamp, type Transaction } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import {
  COLLECTIONS,
  NON_TERMINAL_REQUEST_STATUSES,
  type ApprovalRecord,
  type ApproverNotificationRecord,
  type AuditActor,
  type AuditEvent,
  type LifecycleRequest,
  type LifecycleStep,
  type RequestStatus,
  type StepStatus,
} from './model.js';
import type { NewRequestDocuments } from './requestFactory.js';
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

/**
 * A target user already has a request in flight. Callers map this to 409.
 * Carries the blocking request so an operator is told what to wait for rather
 * than just being refused.
 */
export class ConflictingRequestError extends Error {
  constructor(
    readonly targetUser: string,
    readonly existingRequestId: string,
    readonly existingStatus: RequestStatus,
  ) {
    super(
      `${targetUser} already has a non-terminal request (${existingRequestId}, ${existingStatus}). ` +
        'Wait for it to finish or cancel it before submitting another.',
    );
    this.name = 'ConflictingRequestError';
  }
}

/**
 * The requester tried to approve their own request. Callers map this to 403.
 * Checked against the IAP-verified identity inside the transaction, never
 * against anything the client supplied (REQ-002 AC-2).
 */
export class SelfApprovalError extends Error {
  constructor(readonly requestId: string, readonly identity: string) {
    super(
      `${identity} created request ${requestId} and cannot approve it. ` +
        'Two-party approval requires a second, distinct identity.',
    );
    this.name = 'SelfApprovalError';
  }
}

/** The step is not waiting on anyone. Callers map this to 409. */
export class StepNotAwaitingApprovalError extends Error {
  constructor(
    readonly requestId: string,
    readonly stepId: string,
    readonly observed: StepStatus,
  ) {
    super(`Step ${stepId} of ${requestId} is '${observed}', not awaiting approval.`);
    this.name = 'StepNotAwaitingApprovalError';
  }
}

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
   * Admits a new lifecycle request: the request document, one step document per
   * plan entry, and the admission audit event, in ONE transaction.
   *
   * The concurrency guard is a query issued INSIDE that transaction, before any
   * write. Checking beforehand would leave a window in which two operators both
   * see no conflict and both create a request against the same account, which
   * is the exact race REQ-001 AC-2 exists to close. Firestore aborts and
   * retries the transaction when the queried set changes under it, so the loser
   * re-reads and sees the winner's request.
   *
   * Nothing is dispatched here. The request lands in 'draft' with every step
   * 'pending'; starting the first step is the caller's next move, so a failure
   * to dispatch cannot leave a half-created request behind.
   *
   * Serves REQ-001.
   */
  async createRequest(
    documents: NewRequestDocuments,
    actor: AuditActor,
  ): Promise<NewRequestDocuments> {
    const { request, steps } = documents;

    await this.db.runTransaction(async (tx) => {
      // READ FIRST. Firestore requires every read in a transaction to precede
      // every write, and this read is also the guard, so the ordering is not
      // incidental.
      const conflicting = await tx.get(
        this.db
          .collection(COLLECTIONS.requests)
          .where('targetUser', '==', request.targetUser)
          .where('status', 'in', NON_TERMINAL_REQUEST_STATUSES)
          .limit(1),
      );

      if (!conflicting.empty) {
        const existing = conflicting.docs[0]!.data() as LifecycleRequest;
        throw new ConflictingRequestError(request.targetUser, existing.requestId, existing.status);
      }

      tx.create(this.requestRef(request.requestId), request);
      for (const step of steps) {
        tx.create(this.stepRef(request.requestId, step.stepId), step);
      }

      this.appendAudit(tx, request.requestId, null, {
        actor,
        action: 'request.created',
        targetUser: request.targetUser,
        before: null,
        after: { phase: request.phase, status: request.status, stepCount: steps.length },
      });
    });

    return documents;
  }

  /**
   * Starts a newly admitted request: releases its first step, or halts it for
   * approval, according to the policy snapshotted at creation.
   *
   * ON "ENQUEUED IN THE SAME TRANSACTION" (REQ-001 AC-7, REQ-016 AC-7).
   * A Cloud Tasks enqueue is a call to a different system and CANNOT be part of
   * a Firestore transaction. Taking the criterion literally is impossible. What
   * it is actually asking for is that a halt can never be committed without the
   * notification being committed to, and that is achievable: the notification
   * record is written in the same transaction as the halt, so the two land
   * together or not at all. The record is the outbox entry; REQ-032 sends from
   * it and stamps sentAt. If the send is lost, the outstanding record is what
   * lets a sweeper find it, which a fire-and-forget enqueue after commit would
   * not.
   *
   * Returns what the caller should enqueue AFTER the transaction commits.
   * Enqueueing inside would risk a task for a transaction that then aborted.
   */
  async startFirstStep(
    requestId: string,
    actor: AuditActor,
  ): Promise<{ outcome: 'dispatched' | 'awaiting_approval'; step: LifecycleStep }> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.requestRef(requestId);
      const requestSnap = await tx.get(requestRef);
      if (!requestSnap.exists) throw new Error(`Request ${requestId} not found`);
      const request = requestSnap.data() as LifecycleRequest;

      const firstSnap = await tx.get(
        requestRef.collection(COLLECTIONS.steps).orderBy('ordinal', 'asc').limit(1),
      );
      const firstDoc = firstSnap.docs[0];
      if (!firstDoc) throw new Error(`Request ${requestId} has no steps`);
      const step = firstDoc.data() as LifecycleStep;

      assertRequestTransition(requestId, request.status, 'running');

      if (step.requiresApproval) {
        assertStepTransition(step.stepId, step.status, 'awaiting_approval');

        const notification: ApproverNotificationRecord = {
          sentAt: null,
          recipients: [],
          deliveryId: null,
          error: null,
        };

        tx.update(firstDoc.ref, { status: 'awaiting_approval', approverNotification: notification });
        tx.update(requestRef, { status: 'awaiting_approval', updatedAt: Timestamp.now() });
        this.appendAudit(tx, requestId, step.stepId, {
          actor,
          action: 'step.awaiting_approval',
          targetUser: request.targetUser,
          before: { status: step.status },
          after: { status: 'awaiting_approval', notificationScheduled: true },
        });

        return { outcome: 'awaiting_approval' as const, step: { ...step, status: 'awaiting_approval' as const } };
      }

      assertStepTransition(step.stepId, step.status, 'ready');
      tx.update(firstDoc.ref, { status: 'ready' });
      tx.update(requestRef, { status: 'running', updatedAt: Timestamp.now() });
      this.appendAudit(tx, requestId, step.stepId, {
        actor,
        action: 'step.dispatched',
        targetUser: request.targetUser,
        before: { status: step.status },
        after: { status: 'ready' },
      });

      return { outcome: 'dispatched' as const, step: { ...step, status: 'ready' as const } };
    });
  }

  /**
   * Records an approval decision on a halted step, in ONE transaction.
   *
   * The self-approval check lives HERE, inside the transaction, against the
   * request's persisted requestedBy and the caller's verified identity. Putting
   * it in the route would leave it bypassable by any future caller of this
   * method, and two-party approval that can be bypassed is not two-party
   * approval. The status re-read in the same transaction also makes a double
   * submit safe: the second observes a step that is no longer awaiting.
   *
   * Approval releases the step to 'ready' and returns the request to 'running'.
   * Rejection fails the step and terminates the request in 'rejected'; no
   * further step is dispatched because nothing dispatches from a terminal
   * request.
   *
   * Serves REQ-002.
   */
  async decideStep(params: {
    requestId: string;
    stepId: string;
    decision: 'approved' | 'rejected';
    approver: AuditActor;
    justification: string;
  }): Promise<{ stepStatus: StepStatus; requestStatus: RequestStatus; idempotencyKey: string }> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.requestRef(params.requestId);
      const stepRef = this.stepRef(params.requestId, params.stepId);

      const [requestSnap, stepSnap] = await Promise.all([tx.get(requestRef), tx.get(stepRef)]);
      if (!requestSnap.exists) throw new Error(`Request ${params.requestId} not found`);
      if (!stepSnap.exists) {
        throw new Error(`Step ${params.stepId} not found on request ${params.requestId}`);
      }

      const request = requestSnap.data() as LifecycleRequest;
      const step = stepSnap.data() as LifecycleStep;

      if (step.status !== 'awaiting_approval') {
        throw new StepNotAwaitingApprovalError(params.requestId, params.stepId, step.status);
      }

      const approver = params.approver.email.toLowerCase();
      if (approver === request.requestedBy) {
        throw new SelfApprovalError(params.requestId, approver);
      }

      const approval: ApprovalRecord = {
        approvedBy: approver,
        decision: params.decision,
        justification: params.justification,
        at: Timestamp.now(),
      };

      const nextStep: StepStatus = params.decision === 'approved' ? 'ready' : 'failed';
      const nextRequest: RequestStatus = params.decision === 'approved' ? 'running' : 'rejected';

      assertStepTransition(params.stepId, step.status, nextStep);
      assertRequestTransition(params.requestId, request.status, nextRequest);

      tx.update(stepRef, { status: nextStep, approval });
      tx.update(requestRef, { status: nextRequest, updatedAt: Timestamp.now() });

      this.appendAudit(tx, params.requestId, params.stepId, {
        actor: params.approver,
        action: `step.${params.decision}`,
        targetUser: request.targetUser,
        before: { status: step.status },
        after: { status: nextStep, requestStatus: nextRequest, justification: params.justification },
      });

      // The idempotency key comes back with the decision so the caller can
      // enqueue the released step without a second read. The key is the task's
      // deduplication discriminator, so returning it here is what lets the
      // approval path and the worker's own dispatch agree on one task name.
      return {
        stepStatus: nextStep,
        requestStatus: nextRequest,
        idempotencyKey: step.idempotencyKey,
      };
    });
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
