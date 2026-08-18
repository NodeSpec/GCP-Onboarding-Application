import { Firestore, Timestamp, type Transaction } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import {
  COLLECTIONS,
  NON_TERMINAL_REQUEST_STATUSES,
  isTerminalRequestStatus,
  type ApprovalPolicy,
  type ApprovalRecord,
  type ApproverNotificationRecord,
  type AuditActor,
  type AuditEvent,
  type CredentialHandoff,
  type CredentialStepRecord,
  type LifecycleRequest,
  type LifecycleStep,
  type NotificationRecord,
  type OperatorRole,
  type Phase,
  type RequestStatus,
  type RoleBinding,
  type StepStatus,
  type UpdateDiff,
} from './model.js';
import { normalisePolicy, policyPath } from './policy.js';
import type { NewRequestDocuments } from './requestFactory.js';
import { deriveIdempotencyKey } from './stepPlans.js';
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

/**
 * Writes one audit event inside a transaction the caller already owns.
 *
 * Exported, unlike the private method that wraps it, for exactly one reason:
 * the credential handoff claim has to destroy the ciphertext and record who
 * took it in ONE transaction, and that transaction lives in CredentialStore,
 * where the decryption key is. A second copy of this function there would have
 * meant two implementations of the audit record, and the guarantee that every
 * audited change carries its record would then be enforced in two places
 * (REQ-017 AC-6).
 *
 * It takes a Transaction and nothing else, so it still cannot be used to write
 * an audit event on its own: a caller has to be inside a transaction that is
 * doing something. It creates, and never updates or deletes, so the collection
 * stays append only.
 */
export function appendAuditEvent(
  db: Firestore,
  tx: Transaction,
  requestId: string | null,
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
  tx.create(db.collection(COLLECTIONS.audit).doc(event.eventId), event);
  return event;
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

  /**
   * The operator's request list (REQ-011 AC-4).
   *
   * Filtered on the server and paginated with a cursor rather than an offset.
   * Offset paging re-reads and re-bills every skipped document, and on a
   * collection that grows for the life of the tenant that turns page 40 into a
   * scan of the whole history. A cursor reads exactly one page.
   *
   * Ordered by createdAt descending, tie-broken on requestId. The tie-break is
   * not decoration: two requests submitted in the same millisecond are ordinary
   * under a bulk onboarding, and without a total order a cursor can loop or
   * skip at the boundary.
   *
   * Every filter is an equality, so the composite indexes this needs are
   * predictable and are declared with the Firestore provisioning (REQ-020).
   */
  async listRequests(
    options: {
      phase?: Phase;
      status?: RequestStatus;
      targetUser?: string;
      limit?: number;
      cursor?: { createdAt: Timestamp; requestId: string } | null;
    } = {},
  ): Promise<{ requests: LifecycleRequest[]; nextCursor: { createdAt: string; requestId: string } | null }> {
    // Capped so a caller cannot ask for the collection in one request.
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

    let query = this.db
      .collection(COLLECTIONS.requests)
      .orderBy('createdAt', 'desc')
      .orderBy('requestId', 'desc') as FirebaseFirestore.Query;

    if (options.phase) query = query.where('phase', '==', options.phase);
    if (options.status) query = query.where('status', '==', options.status);
    if (options.targetUser) {
      query = query.where('targetUser', '==', options.targetUser.trim().toLowerCase());
    }
    if (options.cursor) {
      query = query.startAfter(options.cursor.createdAt, options.cursor.requestId);
    }

    // One more than asked for, so "is there another page" is answered without a
    // second count query.
    const snap = await query.limit(limit + 1).get();
    const docs = snap.docs.slice(0, limit);
    const requests = docs.map((doc) => doc.data() as LifecycleRequest);

    const last = requests[requests.length - 1];
    const nextCursor =
      snap.docs.length > limit && last
        ? { createdAt: last.createdAt.toDate().toISOString(), requestId: last.requestId }
        : null;

    return { requests, nextCursor };
  }

  /**
   * Requests halted for approval, each with the step that is waiting
   * (REQ-011 AC-6).
   *
   * Returns everything halted rather than everything one operator may approve.
   * Eligibility depends on the caller's roles and on not being the requester,
   * and both belong to the API layer that knows who is asking; deciding it here
   * would put an authorization rule in the data access layer where the route's
   * own check could drift away from it.
   *
   * The awaiting step is fetched per request. That is an N+1, and it is bounded
   * on purpose: a halted request is blocked work an organisation is actively
   * trying to clear, so this collection is small by construction. If it ever is
   * not, the queue itself is the problem this list is reporting.
   */
  async listAwaitingApproval(
    limit = 50,
  ): Promise<{ request: LifecycleRequest; step: LifecycleStep }[]> {
    const snap = await this.db
      .collection(COLLECTIONS.requests)
      .where('status', '==', 'awaiting_approval')
      .orderBy('updatedAt', 'desc')
      .limit(Math.min(Math.max(limit, 1), 100))
      .get();

    const pending: { request: LifecycleRequest; step: LifecycleStep }[] = [];
    for (const doc of snap.docs) {
      const request = doc.data() as LifecycleRequest;
      const steps = await doc.ref
        .collection(COLLECTIONS.steps)
        .where('status', '==', 'awaiting_approval')
        .limit(1)
        .get();

      const step = steps.docs[0]?.data() as LifecycleStep | undefined;
      // A request marked awaiting_approval with no waiting step is an
      // inconsistency, not an inbox entry. Skipped rather than rendered as a
      // row an approver cannot act on.
      if (step) pending.push({ request, step });
    }

    return pending;
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
   * The whole audit trail, newest first, for the admin view (REQ-012 AC-5).
   *
   * Bounded by `limit` rather than returning everything: this collection grows
   * without limit and an unbounded read would eventually be the slowest, most
   * expensive query in the system. `before` pages backwards through it.
   */
  async listAllAudit(options: { limit?: number; before?: Timestamp } = {}): Promise<AuditEvent[]> {
    let query = this.db
      .collection(COLLECTIONS.audit)
      .orderBy('timestamp', 'desc')
      .limit(Math.min(options.limit ?? 100, 500));

    if (options.before) query = query.startAfter(options.before);

    const snap = await query.get();
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
   * a Firestore transaction. What the criteria ask for is that a halt can never
   * be committed without the notification being committed to, and that is
   * achievable: the notification record is written in the same transaction as
   * the halt, so the two land together or not at all. The record is the outbox
   * entry; REQ-032 sends from it and stamps sentAt. If the send is lost, the
   * outstanding record is what lets a sweeper find it, which a fire-and-forget
   * enqueue after commit would not.
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
   * Expires a pending approval when its scheduled task fires (REQ-002 AC-7).
   *
   * The decision about whether anything expires is made HERE, inside the
   * transaction, against the step's current status, not at enqueue time and not
   * in the route. The expiry task is scheduled the moment a step halts and then
   * fires unconditionally hours later; by then the step has usually been
   * decided, and the common case of this method is doing nothing. That is the
   * design: a no-op task is free, but an expiry that raced a same-instant
   * approval outside a transaction could reject a request a human had just
   * released.
   *
   * An expiry is a rejection with nobody to name. The step fails with a typed
   * error rather than acquiring a synthetic ApprovalRecord, because approval
   * records name the human who decided and inventing a system "approver" would
   * make the audit trail lie about a person existing.
   */
  async expireApproval(params: {
    requestId: string;
    stepId: string;
    actor: AuditActor;
  }): Promise<{ expired: boolean; observedStep: StepStatus | null; observedRequest: RequestStatus | null }> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.requestRef(params.requestId);
      const stepRef = this.stepRef(params.requestId, params.stepId);

      const [requestSnap, stepSnap] = await Promise.all([tx.get(requestRef), tx.get(stepRef)]);
      // A firing for a request that no longer exists is a no-op, not an error:
      // the task outlived its subject, which retrying cannot change.
      if (!requestSnap.exists || !stepSnap.exists) {
        return { expired: false, observedStep: null, observedRequest: null };
      }

      const request = requestSnap.data() as LifecycleRequest;
      const step = stepSnap.data() as LifecycleStep;

      // Decided, cancelled, or never halted: the task fired after the fact.
      // This is the normal outcome of most expiry tasks and is deliberately
      // silent in the trail; auditing millions of "nothing happened" firings
      // would bury the events the trail exists to surface.
      if (step.status !== 'awaiting_approval' || isTerminalRequestStatus(request.status)) {
        return { expired: false, observedStep: step.status, observedRequest: request.status };
      }

      assertStepTransition(params.stepId, step.status, 'failed');
      assertRequestTransition(params.requestId, request.status, 'rejected');

      tx.update(stepRef, {
        status: 'failed',
        error: {
          class: 'terminal',
          code: 'approval_expired',
          message: 'No approver decided within the configured expiry window.',
        },
        completedAt: Timestamp.now(),
      });
      tx.update(requestRef, { status: 'rejected', updatedAt: Timestamp.now() });

      this.appendAudit(tx, params.requestId, params.stepId, {
        actor: params.actor,
        action: 'approval.expired',
        targetUser: request.targetUser,
        outcome: 'failure',
        before: { status: step.status, requestStatus: request.status },
        after: { status: 'failed', requestStatus: 'rejected', reason: 'approval_expired' },
      });

      return { expired: true, observedStep: step.status, observedRequest: request.status };
    });
  }

  // ---------------------------------------------------------------------------
  // Admin capabilities (REQ-012 AC-5)
  // ---------------------------------------------------------------------------

  async getApprovalPolicy(): Promise<ApprovalPolicy> {
    const snap = await this.db.doc(policyPath()).get();
    return normalisePolicy(snap.exists ? snap.data() : undefined);
  }

  /**
   * Replaces the approval policy, recording the whole document before and after.
   *
   * The policy decides which steps need a second pair of eyes, so an edit is a
   * change to a security control and the trail has to show what it was as well
   * as what it became. Requests already in flight are unaffected: they carry a
   * snapshot taken at creation (REQ-002 AC-6), which is why this method does not
   * touch them.
   */
  async setApprovalPolicy(params: {
    policy: ApprovalPolicy;
    actor: AuditActor;
  }): Promise<{ before: ApprovalPolicy; after: ApprovalPolicy }> {
    const after = normalisePolicy(params.policy);

    return this.db.runTransaction(async (tx) => {
      const ref = this.db.doc(policyPath());
      const snap = await tx.get(ref);
      const before = normalisePolicy(snap.exists ? snap.data() : undefined);

      tx.set(ref, after);

      this.appendAudit(tx, null, null, {
        actor: params.actor,
        action: 'approvalPolicy.updated',
        before: { policy: before },
        after: { policy: after },
      });

      return { before, after };
    });
  }

  /**
   * Cancels a request and skips everything it had not yet done.
   *
   * Pending steps are moved to 'skipped' in the SAME transaction as the
   * cancellation. Leaving them 'pending' would mean a task already in the queue
   * could still find work to do on a cancelled request, which is precisely what
   * an operator hitting cancel is trying to prevent. A step already running is
   * left alone: it is mid-flight against Workspace and cannot be recalled, so
   * the honest thing is to let it finish and stop there.
   */
  async cancelRequest(params: {
    requestId: string;
    actor: AuditActor;
    reason: string;
  }): Promise<{ cancelled: boolean; observed: RequestStatus; skippedSteps: number }> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.requestRef(params.requestId);
      const requestSnap = await tx.get(requestRef);
      if (!requestSnap.exists) throw new Error(`Request ${params.requestId} not found`);
      const request = requestSnap.data() as LifecycleRequest;

      const stepsSnap = await tx.get(requestRef.collection(COLLECTIONS.steps));

      if (isTerminalRequestStatus(request.status)) {
        return { cancelled: false, observed: request.status, skippedSteps: 0 };
      }

      assertRequestTransition(params.requestId, request.status, 'cancelled');

      let skipped = 0;
      for (const doc of stepsSnap.docs) {
        const step = doc.data() as LifecycleStep;
        if (step.status !== 'pending' && step.status !== 'awaiting_approval') continue;
        // 'awaiting_approval' has no legal move to 'skipped'; a cancelled
        // approval is a failure of that step, not a silent pass.
        const to = step.status === 'pending' ? 'skipped' : 'failed';
        assertStepTransition(step.stepId, step.status, to);
        tx.update(doc.ref, { status: to, completedAt: Timestamp.now() });
        skipped += 1;
      }

      tx.update(requestRef, { status: 'cancelled', updatedAt: Timestamp.now() });

      this.appendAudit(tx, params.requestId, null, {
        actor: params.actor,
        action: 'request.cancelled',
        targetUser: request.targetUser,
        before: { status: request.status },
        after: { status: 'cancelled', reason: params.reason, stepsStopped: skipped },
      });

      return { cancelled: true, observed: request.status, skippedSteps: skipped };
    });
  }

  /**
   * Cancels an offboarding that has already suspended the account, by appending
   * a compensating step rather than terminating the request (REQ-006 AC-4).
   *
   * The distinction this method exists for: by the time someone cancels a phase
   * 4 request, the account is suspended in WORKSPACE, and putting it back is a
   * Workspace mutation. Mutations only ever happen in the executor, so a
   * cancellation that merely flipped the request to 'cancelled' would leave a
   * real person locked out of a real account with the trail claiming the
   * offboarding was called off. Cancelling therefore becomes work.
   *
   * The request deliberately stays in flight. It reaches 'cancelled' only when
   * the appended step succeeds, and if that step fails the executor fails the
   * request in the ordinary way, leaving the account suspended, the error
   * recorded, and the state visibly wrong rather than silently wrong (AC-5,
   * AC-6).
   *
   * Returns the appended step so the caller dispatches it AFTER the commit, for
   * the same reason startFirstStep does.
   */
  async appendCompensatingStep(params: {
    requestId: string;
    stepName: string;
    actor: AuditActor;
    reason: string;
  }): Promise<{ appended: boolean; observed: RequestStatus; step: LifecycleStep | null }> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.requestRef(params.requestId);
      const requestSnap = await tx.get(requestRef);
      if (!requestSnap.exists) throw new Error(`Request ${params.requestId} not found`);
      const request = requestSnap.data() as LifecycleRequest;

      const stepsSnap = await tx.get(requestRef.collection(COLLECTIONS.steps).orderBy('ordinal', 'asc'));

      // Already finished, one way or another. Nothing to compensate, and
      // appending work to a terminal request would restart it.
      if (isTerminalRequestStatus(request.status)) {
        return { appended: false, observed: request.status, step: null };
      }

      const existing = stepsSnap.docs.map((doc) => doc.data() as LifecycleStep);

      // Idempotent: a redelivered or repeated cancellation must not append a
      // second compensating step, which would run the undo twice and, worse,
      // leave the plan with a trailing step nobody dispatched.
      const already = existing.find((step) => step.name === params.stepName);
      if (already) {
        return { appended: false, observed: request.status, step: already };
      }

      // Stop everything not yet started, exactly as an ordinary cancellation
      // does. A task already queued for a later step would otherwise still find
      // work to do while the compensation is running.
      let stopped = 0;
      for (const doc of stepsSnap.docs) {
        const step = doc.data() as LifecycleStep;
        if (step.status !== 'pending' && step.status !== 'awaiting_approval') continue;
        const to = step.status === 'pending' ? 'skipped' : 'failed';
        assertStepTransition(step.stepId, step.status, to);
        tx.update(doc.ref, { status: to, completedAt: Timestamp.now() });
        stopped += 1;
      }

      const ordinal = existing.reduce((max, step) => Math.max(max, step.ordinal), -1) + 1;
      const stepId = `${String(ordinal).padStart(3, '0')}-${params.stepName}`;
      const step: LifecycleStep = {
        stepId,
        name: params.stepName,
        ordinal,
        // Released immediately. The compensation is the whole point of the
        // cancellation, so it does not wait behind an approval: a second pair
        // of eyes on restoring access someone just asked to restore would only
        // extend the window in which the account is wrongly suspended.
        status: 'ready',
        attempts: 0,
        requiresApproval: false,
        idempotencyKey: deriveIdempotencyKey(params.requestId, stepId, {}),
        input: {},
        output: null,
        error: null,
        approval: null,
        approverNotification: null,
        notification: null,
        credential: null,
        startedAt: null,
        completedAt: null,
      };
      tx.create(this.stepRef(params.requestId, stepId), step);

      // Back to 'running', because that is what it is: the request has work in
      // flight again. It is NOT 'cancelled' yet and must not be.
      if (request.status !== 'running') {
        assertRequestTransition(params.requestId, request.status, 'running');
        tx.update(requestRef, { status: 'running', updatedAt: Timestamp.now() });
      }

      this.appendAudit(tx, params.requestId, stepId, {
        actor: params.actor,
        action: 'request.cancellation_requested',
        targetUser: request.targetUser,
        before: { status: request.status },
        after: {
          status: 'running',
          compensatingStep: params.stepName,
          reason: params.reason,
          stepsStopped: stopped,
        },
      });

      return { appended: true, observed: request.status, step };
    });
  }

  /**
   * Puts a failed request back to work at its failed step.
   *
   * Returns the step to enqueue so the caller can dispatch AFTER the commit, on
   * the same reasoning as startFirstStep: a task for a transaction that then
   * aborted is worse than a resume that has to be retried.
   */
  async resumeRequest(params: {
    requestId: string;
    actor: AuditActor;
  }): Promise<{ resumed: boolean; observed: RequestStatus; step: LifecycleStep | null }> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.requestRef(params.requestId);
      const requestSnap = await tx.get(requestRef);
      if (!requestSnap.exists) throw new Error(`Request ${params.requestId} not found`);
      const request = requestSnap.data() as LifecycleRequest;

      const stepsSnap = await tx.get(requestRef.collection(COLLECTIONS.steps).orderBy('ordinal', 'asc'));

      if (request.status !== 'failed') {
        return { resumed: false, observed: request.status, step: null };
      }

      const failedDoc = stepsSnap.docs.find((d) => (d.data() as LifecycleStep).status === 'failed');
      if (!failedDoc) {
        // The request failed without a failed step, so there is nothing to
        // retry. Refusing is better than guessing which step to restart.
        return { resumed: false, observed: request.status, step: null };
      }

      const step = failedDoc.data() as LifecycleStep;
      assertStepTransition(step.stepId, step.status, 'ready');
      assertRequestTransition(params.requestId, request.status, 'running');

      // The error is cleared, the attempt counter is NOT. A resume is another
      // attempt, and hiding that would make a step that has failed five times
      // look untouched.
      tx.update(failedDoc.ref, { status: 'ready', error: null, completedAt: null });
      tx.update(requestRef, { status: 'running', updatedAt: Timestamp.now() });

      this.appendAudit(tx, params.requestId, step.stepId, {
        actor: params.actor,
        action: 'request.resumed',
        targetUser: request.targetUser,
        before: { status: 'failed', stepStatus: 'failed', attempts: step.attempts },
        after: { status: 'running', stepStatus: 'ready' },
      });

      return { resumed: true, observed: request.status, step: { ...step, status: 'ready' as const } };
    });
  }

  // ---------------------------------------------------------------------------
  // Role bindings (REQ-012)
  //
  // These live on this class rather than in a store of their own precisely
  // because of the audit invariant above: appendAudit is private, so a second
  // class writing role-change audit events would have needed its own copy, and
  // the guarantee that no audited change can be written without its record
  // would then be enforced in two places instead of one.
  // ---------------------------------------------------------------------------

  private roleBindingRef(subject: string) {
    return this.db.collection(COLLECTIONS.roleBindings).doc(subject.toLowerCase());
  }

  async getRoleBinding(subject: string): Promise<RoleBinding | null> {
    const snap = await this.roleBindingRef(subject).get();
    return snap.exists ? (snap.data() as RoleBinding) : null;
  }

  /** Every binding, for the admin view. Subject is the document id. */
  async listRoleBindings(): Promise<(RoleBinding & { subject: string })[]> {
    const snap = await this.db.collection(COLLECTIONS.roleBindings).get();
    return snap.docs.map((doc) => ({ ...(doc.data() as RoleBinding), subject: doc.id }));
  }

  /**
   * Grants a subject a set of roles, replacing whatever it held.
   *
   * The audit event carries the roles BEFORE and AFTER, in one transaction with
   * the write (REQ-012 AC-6). Recording only the new set would make a privilege
   * escalation and a no-op edit look identical in the trail, which is the one
   * question this record exists to answer.
   */
  async setRoleBinding(params: {
    subject: string;
    kind: 'user' | 'group';
    roles: OperatorRole[];
    actor: AuditActor;
  }): Promise<{ before: OperatorRole[] | null; after: OperatorRole[] }> {
    const subject = params.subject.toLowerCase();
    // Deduplicated and ordered, so the before/after comparison in the audit
    // trail reflects a real privilege change rather than a reordering.
    const roles = [...new Set(params.roles)].sort();

    return this.db.runTransaction(async (tx) => {
      const ref = this.roleBindingRef(subject);
      const snap = await tx.get(ref);
      const before = snap.exists ? (snap.data() as RoleBinding).roles : null;

      const record: RoleBinding = {
        kind: params.kind,
        roles,
        updatedBy: params.actor.email.toLowerCase(),
        updatedAt: Timestamp.now(),
      };
      tx.set(ref, record);

      this.appendAudit(tx, null, null, {
        actor: params.actor,
        action: 'roleBinding.set',
        targetUser: subject,
        before: before === null ? null : { roles: before },
        after: { roles, kind: params.kind },
      });

      return { before, after: roles };
    });
  }

  /** Removes a binding entirely, leaving the subject authorized for nothing. */
  async removeRoleBinding(params: {
    subject: string;
    actor: AuditActor;
  }): Promise<{ before: OperatorRole[] | null }> {
    const subject = params.subject.toLowerCase();

    return this.db.runTransaction(async (tx) => {
      const ref = this.roleBindingRef(subject);
      const snap = await tx.get(ref);
      if (!snap.exists) return { before: null };

      const before = (snap.data() as RoleBinding).roles;
      tx.delete(ref);

      this.appendAudit(tx, null, null, {
        actor: params.actor,
        action: 'roleBinding.removed',
        targetUser: subject,
        before: { roles: before },
        after: { roles: [] },
      });

      return { before };
    });
  }

  /**
   * The only way to write an audit event. Private to this module and always
   * called from a transition, so an audit event cannot be written without the
   * change it describes.
   */
  private appendAudit(
    tx: Transaction,
    requestId: string | null,
    stepId: string | null,
    input: AuditInput,
  ): AuditEvent {
    return appendAuditEvent(this.db, tx, requestId, stepId, input);
  }

  /**
   * Freezes a phase 3 request's computed diff onto the request (REQ-005 AC-1).
   *
   * Written once, before anything mutates, and audited in the same transaction
   * like every other state change. The audit event carries the change set in
   * full rather than a count: this is the record of what an approver was shown,
   * and "3 attributes changed" would not answer the question an auditor is
   * actually asking six months later.
   */
  async recordComputedDiff(params: {
    requestId: string;
    stepId: string;
    diff: UpdateDiff;
    actor: AuditActor;
  }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const ref = this.requestRef(params.requestId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error(`Request ${params.requestId} not found`);

      const existing = (snap.data() as LifecycleRequest).computedDiff;

      tx.update(ref, { computedDiff: params.diff, updatedAt: Timestamp.now() });

      this.appendAudit(tx, params.requestId, params.stepId, {
        actor: params.actor,
        action: 'request.diff_computed',
        targetUser: params.diff.targetUser,
        // Non-null only on a recompute, which happens when a step is
        // redelivered. Recording the prior diff makes that visible rather than
        // silently replacing what an approver may already have seen.
        before: existing === null ? null : { computedDiff: existing },
        after: {
          attributes: params.diff.attributes.filter((a) => a.changed),
          groups: params.diff.groups.filter((g) => g.changed),
          requestedAttributes: params.diff.attributes.length,
          requestedGroups: params.diff.groups.length,
        },
      });
    });
  }

  /**
   * Records the outcome of an outbound message on a step, WITHOUT moving it.
   *
   * A separate path from transitionStep because sending is not a status change:
   * the record has to be durable the instant the provider accepts, before the
   * step is settled, or a crash in between would lose the delivery id and the
   * replay would send a second copy (REQ-004 AC-3, REQ-032 AC-4). It is still
   * audited in the same transaction, so this does not become a way to change
   * state without a record.
   *
   * `field` picks which record to write: 'notification' for a step whose own
   * work was to send, 'approverNotification' for the notice about a halt.
   */
  async recordNotification(params: {
    requestId: string;
    stepId: string;
    field: 'notification' | 'approverNotification';
    record: NotificationRecord;
    actor: AuditActor;
    action: string;
  }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const ref = this.stepRef(params.requestId, params.stepId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(`Step ${params.stepId} not found on request ${params.requestId}`);
      }

      tx.update(ref, { [params.field]: params.record });

      this.appendAudit(tx, params.requestId, params.stepId, {
        actor: params.actor,
        action: params.action,
        // Recipients are addresses, not message content. The body is never
        // audited: it is rendered from a template and could carry anything the
        // template author put there.
        after: {
          recipients: params.record.recipients,
          deliveryId: params.record.deliveryId,
          error: params.record.error,
        },
        outcome: params.record.error === null ? 'success' : 'failure',
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Credential handoff (REQ-017, REQ-030)
  //
  // These documents live in their own collection but their lifecycle is
  // lifecycle state, so the transactions are here rather than in CredentialStore
  // for the same reason the role bindings are: appendAudit is private, and an
  // audited change written from a second class would have needed a second copy
  // of it. CredentialStore keeps the crypto, which needs neither a transaction
  // nor an audit event.
  // ---------------------------------------------------------------------------

  private handoffRef(credentialRequestId: string) {
    return this.db.collection(COLLECTIONS.credentialHandoffs).doc(credentialRequestId);
  }

  /**
   * Records what a step decided about the one-time password, and where the step
   * rotated it, installs the new ciphertext and invalidates the old record, all
   * in ONE transaction (REQ-030 AC-4, AC-6).
   *
   * The writes belong together. A new ciphertext committed without the
   * invalidation would leave two live credentials for one account, only one of
   * which actually signs in; an invalidation committed without its replacement
   * would leave the account with a password nobody holds. Neither is a state an
   * operator could untangle from the trail afterwards.
   *
   * NEITHER PASSWORD IS AUDITED. The event names the operator, the target user
   * and the records involved, and nothing else. An audit trail readable by
   * everyone entitled to read audit is not a place to put a credential (AC-6).
   */
  async recordCredential(params: {
    requestId: string;
    stepId: string;
    targetUser: string;
    record: CredentialStepRecord;
    /** Present only for a rotation. Absent when an existing record is reused. */
    rotation?: {
      /** Written at credentialHandoffs/{requestId}. Already encrypted. */
      handoff: CredentialHandoff;
      /** The record this replaces, if the account had a live one. */
      supersedes: string | null;
    };
    actor: AuditActor;
    action: string;
  }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const stepRef = this.stepRef(params.requestId, params.stepId);

      // Every read first: Firestore requires it, and the superseded record has
      // to be read before it can be invalidated.
      const supersedes = params.rotation?.supersedes ?? null;
      const [stepSnap, supersededSnap] = await Promise.all([
        tx.get(stepRef),
        supersedes === null ? Promise.resolve(null) : tx.get(this.handoffRef(supersedes)),
      ]);

      if (!stepSnap.exists) {
        throw new Error(`Step ${params.stepId} not found on request ${params.requestId}`);
      }

      if (params.rotation) {
        tx.set(this.handoffRef(params.requestId), params.rotation.handoff);

        if (supersedes !== null && supersededSnap?.exists) {
          // Emptied, not merely flagged. A flag left beside readable ciphertext
          // is one bug away from handing an operator a password that no longer
          // signs in, which is worse than handing over none (AC-5).
          tx.update(this.handoffRef(supersedes), {
            oneTimePasswordCiphertext: '',
            supersededAt: Timestamp.now(),
            supersededBy: params.requestId,
          });
        }
      }

      tx.update(stepRef, { credential: params.record });

      this.appendAudit(tx, params.requestId, params.stepId, {
        actor: params.actor,
        action: params.action,
        targetUser: params.targetUser,
        before: supersedes === null ? null : { credentialRequestId: supersedes },
        after: {
          credentialRequestId: params.record.credentialRequestId,
          rotated: params.record.rotatedAt !== null,
          keyVersion: params.record.keyVersion,
          expiresAt: params.record.expiresAt.toDate().toISOString(),
        },
      });
    });
  }

  /**
   * Which credentialHandoffs document holds the password for this request.
   *
   * A resend reuses the credential the original create request produced, so the
   * document is not always keyed by the request being asked about. Falls back to
   * the request's own id, which is the create-phase case and the only one that
   * existed before resend (REQ-030).
   */
  async resolveCredentialRequestId(requestId: string): Promise<string> {
    const steps = await this.listSteps(requestId);
    for (const step of steps) {
      const pointer = step.credential?.credentialRequestId;
      if (pointer) return pointer;
    }
    return requestId;
  }

  /**
   * Claims a step for execution, in ONE transaction (REQ-016 AC-1, AC-2).
   *
   * Two deliveries of the same task race here, and exactly one may win. The
   * normal case is 'ready' -> 'running'; the loser re-reads inside the
   * transaction, sees 'running', and is told so rather than executing.
   *
   * The second case is why this is not just transitionStep. An instance killed
   * mid-step leaves its step 'running' with nobody working on it, and nothing
   * would ever move it again: the step is not 'ready', so no redelivery could
   * claim it, and the request would sit wedged forever. So a 'running' step
   * whose lease has expired is RECLAIMABLE. The lease is startedAt plus
   * leaseSeconds, compared inside the transaction, which is what stops a
   * concurrent delivery stealing a claim that is merely slow rather than dead.
   *
   * Pick leaseSeconds well above the longest a step can legitimately take; a
   * lease that expires under a slow-but-live step is how you get a step running
   * twice at once.
   */
  async claimStep(params: {
    requestId: string;
    stepId: string;
    attempt: number;
    leaseSeconds: number;
    audit: AuditInput;
  }): Promise<{ claimed: boolean; observed: StepStatus; reclaimed: boolean }> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.stepRef(params.requestId, params.stepId);
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error(`Step ${params.stepId} not found on request ${params.requestId}`);
      }

      const current = snap.data() as LifecycleStep;

      if (current.status !== 'ready' && current.status !== 'running') {
        return { claimed: false, observed: current.status, reclaimed: false };
      }

      let reclaimed = false;
      if (current.status === 'running') {
        const startedAt = current.startedAt?.toMillis() ?? 0;
        const expired = Date.now() - startedAt >= params.leaseSeconds * 1000;
        // Someone else holds a live claim. Not an error: the work is in hand.
        if (!expired) return { claimed: false, observed: current.status, reclaimed: false };
        reclaimed = true;
      }

      assertStepTransition(params.stepId, current.status, 'running');

      tx.update(ref, {
        status: 'running',
        attempts: params.attempt,
        startedAt: Timestamp.now(),
      });

      this.appendAudit(tx, params.requestId, params.stepId, {
        ...params.audit,
        before: { status: current.status },
        after: { status: 'running', attempt: params.attempt, reclaimed },
      });

      return { claimed: true, observed: current.status, reclaimed };
    });
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

      // MERGED, not replaced. The observed status is authoritative and always
      // wins, but a caller's own context is kept: the executor attaches the
      // error, the attempt and whether the retry budget ran out, and overwriting
      // `after` here discarded all of it, so the trail recorded that a step
      // failed while losing every detail of why.
      this.appendAudit(tx, params.requestId, params.stepId, {
        ...params.audit,
        before: { ...params.audit.before, status: current.status },
        after: { ...params.audit.after, status: params.to },
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

      // Merged for the same reason as transitionStep: the status is
      // authoritative, the caller's context survives alongside it.
      this.appendAudit(tx, params.requestId, null, {
        ...params.audit,
        before: { ...params.audit.before, status: current.status },
        after: { ...params.audit.after, status: params.to },
      });

      return { applied: true, observed: current.status };
    });
  }

  /**
   * Records an authorisation refusal. These carry no state change, so this is
   * the one audit path with nothing to pair with. It is a create-only write to
   * the audit collection and still exposes no update or delete.
   *
   * `path` and `sourceIp` are recorded alongside the reason (REQ-010 AC-3). A
   * refusal without them says someone was turned away and nothing about who
   * from where, which is precisely the question an investigation opens with;
   * with a request id often absent on a 401, they are frequently the ONLY
   * identifying detail the event can carry.
   *
   * `requestId` is nullable because a 401 is refused before any route runs, so
   * there is no request to hang the event on. Inventing a sentinel id would
   * make the per-request audit query return events that were never about it.
   *
   * The ACTOR may be the anonymous principal. On a failed assertion nothing
   * about the caller has been verified, and recording a claimed identity would
   * put an attacker's chosen string into the trail as though it were checked.
   */
  async recordDenied(params: {
    requestId: string | null;
    stepId?: string | null;
    actor: AuditActor;
    action: string;
    reason: string;
    path?: string;
    sourceIp?: string;
    /**
     * The principal the refused action was aimed at, where the refusal was
     * about a target rather than about the caller. A protected-account refusal
     * is only answerable later if the record says WHICH account someone tried
     * to offboard (REQ-031 AC-5).
     */
    targetUser?: string | null;
  }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      this.appendAudit(tx, params.requestId, params.stepId ?? null, {
        actor: params.actor,
        action: params.action,
        targetUser: params.targetUser ?? null,
        after: {
          reason: params.reason,
          path: params.path ?? null,
          sourceIp: params.sourceIp ?? null,
        },
        outcome: 'denied',
      });
    });
  }
}
