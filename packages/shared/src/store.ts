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
  type RequestStatus,
  type RoleBinding,
  type StepStatus,
  type UpdateDiff,
} from './model.js';
import { normalisePolicy, policyPath } from './policy.js';
import type { NewRequestDocuments } from './requestFactory.js';
import { deriveIdempotencyKey } from './stepPlans.js';
import { assertRequestTransition, assertStepTransition } from './transitions.js';

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

export class SelfApprovalError extends Error {
  constructor(readonly requestId: string, readonly identity: string) {
    super(
      `${identity} created request ${requestId} and cannot approve it. ` +
        'Two-party approval requires a second, distinct identity.',
    );
    this.name = 'SelfApprovalError';
  }
}

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

  async listSteps(requestId: string): Promise<LifecycleStep[]> {
    const snap = await this.requestRef(requestId)
      .collection(COLLECTIONS.steps)
      .orderBy('ordinal', 'asc')
      .get();
    return snap.docs.map((doc) => doc.data() as LifecycleStep);
  }

  async listAudit(requestId: string): Promise<AuditEvent[]> {
    const snap = await this.db
      .collection(COLLECTIONS.audit)
      .where('requestId', '==', requestId)
      .orderBy('timestamp', 'asc')
      .get();
    return snap.docs.map((doc) => doc.data() as AuditEvent);
  }

  async listAllAudit(options: { limit?: number; before?: Timestamp } = {}): Promise<AuditEvent[]> {
    let query = this.db
      .collection(COLLECTIONS.audit)
      .orderBy('timestamp', 'desc')
      .limit(Math.min(options.limit ?? 100, 500));

    if (options.before) query = query.startAfter(options.before);

    const snap = await query.get();
    return snap.docs.map((doc) => doc.data() as AuditEvent);
  }

  async createRequest(
    documents: NewRequestDocuments,
    actor: AuditActor,
  ): Promise<NewRequestDocuments> {
    const { request, steps } = documents;

    await this.db.runTransaction(async (tx) => {
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

      return {
        stepStatus: nextStep,
        requestStatus: nextRequest,
        idempotencyKey: step.idempotencyKey,
      };
    });
  }

  async expireApproval(params: {
    requestId: string;
    stepId: string;
    actor: AuditActor;
  }): Promise<{ expired: boolean; observedStep: StepStatus | null; observedRequest: RequestStatus | null }> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.requestRef(params.requestId);
      const stepRef = this.stepRef(params.requestId, params.stepId);

      const [requestSnap, stepSnap] = await Promise.all([tx.get(requestRef), tx.get(stepRef)]);
      if (!requestSnap.exists || !stepSnap.exists) {
        return { expired: false, observedStep: null, observedRequest: null };
      }

      const request = requestSnap.data() as LifecycleRequest;
      const step = stepSnap.data() as LifecycleStep;

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

  async getApprovalPolicy(): Promise<ApprovalPolicy> {
    const snap = await this.db.doc(policyPath()).get();
    return normalisePolicy(snap.exists ? snap.data() : undefined);
  }

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

      if (isTerminalRequestStatus(request.status)) {
        return { appended: false, observed: request.status, step: null };
      }

      const existing = stepsSnap.docs.map((doc) => doc.data() as LifecycleStep);

      const already = existing.find((step) => step.name === params.stepName);
      if (already) {
        return { appended: false, observed: request.status, step: already };
      }

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
        return { resumed: false, observed: request.status, step: null };
      }

      const step = failedDoc.data() as LifecycleStep;
      assertStepTransition(step.stepId, step.status, 'ready');
      assertRequestTransition(params.requestId, request.status, 'running');

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

  private roleBindingRef(subject: string) {
    return this.db.collection(COLLECTIONS.roleBindings).doc(subject.toLowerCase());
  }

  async getRoleBinding(subject: string): Promise<RoleBinding | null> {
    const snap = await this.roleBindingRef(subject).get();
    return snap.exists ? (snap.data() as RoleBinding) : null;
  }

  async listRoleBindings(): Promise<(RoleBinding & { subject: string })[]> {
    const snap = await this.db.collection(COLLECTIONS.roleBindings).get();
    return snap.docs.map((doc) => ({ ...(doc.data() as RoleBinding), subject: doc.id }));
  }

  async setRoleBinding(params: {
    subject: string;
    kind: 'user' | 'group';
    roles: OperatorRole[];
    actor: AuditActor;
  }): Promise<{ before: OperatorRole[] | null; after: OperatorRole[] }> {
    const subject = params.subject.toLowerCase();
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

  private appendAudit(
    tx: Transaction,
    requestId: string | null,
    stepId: string | null,
    input: AuditInput,
  ): AuditEvent {
    return appendAuditEvent(this.db, tx, requestId, stepId, input);
  }

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
        after: {
          recipients: params.record.recipients,
          deliveryId: params.record.deliveryId,
          error: params.record.error,
        },
        outcome: params.record.error === null ? 'success' : 'failure',
      });
    });
  }

  private handoffRef(credentialRequestId: string) {
    return this.db.collection(COLLECTIONS.credentialHandoffs).doc(credentialRequestId);
  }

  async recordCredential(params: {
    requestId: string;
    stepId: string;
    targetUser: string;
    record: CredentialStepRecord;
    rotation?: {
      handoff: CredentialHandoff;
      supersedes: string | null;
    };
    actor: AuditActor;
    action: string;
  }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const stepRef = this.stepRef(params.requestId, params.stepId);

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

  async resolveCredentialRequestId(requestId: string): Promise<string> {
    const steps = await this.listSteps(requestId);
    for (const step of steps) {
      const pointer = step.credential?.credentialRequestId;
      if (pointer) return pointer;
    }
    return requestId;
  }

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
        before: { ...params.audit.before, status: current.status },
        after: { ...params.audit.after, status: params.to },
      });

      return { applied: true, observed: current.status };
    });
  }

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
        before: { ...params.audit.before, status: current.status },
        after: { ...params.audit.after, status: params.to },
      });

      return { applied: true, observed: current.status };
    });
  }

  async recordDenied(params: {
    requestId: string | null;
    stepId?: string | null;
    actor: AuditActor;
    action: string;
    reason: string;
    path?: string;
    sourceIp?: string;
  }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      this.appendAudit(tx, params.requestId, params.stepId ?? null, {
        actor: params.actor,
        action: params.action,
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
