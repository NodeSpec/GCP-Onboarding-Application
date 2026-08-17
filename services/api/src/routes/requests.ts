import {
  ConflictingRequestError,
  InvalidPhasePayload,
  SelfApprovalError,
  StepNotAwaitingApprovalError,
  buildNewRequest,
  normalisePolicy,
  resolveStepPolicy,
  stepPlanFor,
  type ApprovalPolicy,
  type CredentialStore,
  type LifecycleStore,
  type TaskDispatcher,
} from '@lifecycle/shared';
import { Router } from 'express';
import { requireRole, type AuthzOptions, type RoleResolver } from '../authz.js';
import { logger } from '../logging.js';
import { requireIdentity } from '../middleware/iapAuth.js';
import { decisionSchema, submitRequestSchema, validatePayload } from '../schemas.js';

/**
 * The operator request surface.
 *
 * Ordering inside the POST handler is the whole point: validate, build, then
 * persist. Nothing is written until the payload has been accepted and a plan
 * has been produced, so a rejected submission leaves no trace for an operator
 * to wonder about (REQ-001 AC-4).
 *
 * Serves REQ-001. Role checks are mounted per route (REQ-012 AC-1), against the
 * provisional resolver until the binding store exists.
 */

export interface RequestRouteDeps {
  store: LifecycleStore;
  /** Reads the live approval policy. Snapshotted onto each request. */
  loadPolicy: () => Promise<ApprovalPolicy>;
  /** Enqueues onto the lifecycle-steps queue. Shared with the worker. */
  dispatcher: TaskDispatcher;
  resolver?: RoleResolver;
  /** Records a role refusal, with the path and source IP (REQ-010 AC-3). */
  onDenied?: AuthzOptions['onDenied'];
  /**
   * Decrypts the one-time password for handover. Optional: a deployment without
   * it simply has no retrieval route, which is a great deal safer than mounting
   * one that cannot decrypt and answers every caller with a server error.
   */
  credentials?: CredentialStore;
}

export function requestRoutes(deps: RequestRouteDeps): Router {
  const router = Router();
  const authz: AuthzOptions = {
    ...(deps.resolver === undefined ? {} : { resolver: deps.resolver }),
    ...(deps.onDenied === undefined ? {} : { onDenied: deps.onDenied }),
  };

  router.post('/', requireRole('requester', authz), async (req, res) => {
    const identity = requireIdentity(req);

    const envelope = submitRequestSchema.safeParse(req.body);
    if (!envelope.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: envelope.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      });
      return;
    }

    const { phase, payload } = envelope.data;

    const validated = validatePayload(phase, payload);
    if (!validated.ok) {
      res.status(400).json({ error: 'invalid_payload', issues: validated.issues });
      return;
    }

    let documents;
    try {
      documents = buildNewRequest({
        phase,
        targetUser: validated.value.primaryEmail as string,
        requestedBy: identity.email,
        payload: validated.value,
        plan: stepPlanFor(phase, validated.value),
        policy: normalisePolicy(await deps.loadPolicy()),
      });
    } catch (err) {
      // A plan that cannot be built is a payload problem, not a server fault.
      if (err instanceof InvalidPhasePayload) {
        res.status(400).json({ error: 'invalid_payload', issues: [{ path: 'phase', message: err.message }] });
        return;
      }
      throw err;
    }

    try {
      await deps.store.createRequest(documents, { kind: 'human', email: identity.email });
    } catch (err) {
      if (err instanceof ConflictingRequestError) {
        res.status(409).json({
          error: 'conflicting_request',
          message: err.message,
          existingRequestId: err.existingRequestId,
          existingStatus: err.existingStatus,
        });
        return;
      }
      throw err;
    }

    // Started only after the create has committed. A failure here leaves an
    // admitted request in 'draft' that an operator can retry or cancel, which
    // is far better than a half-created request or a dispatched step whose
    // request never landed.
    const started = await deps.store.startFirstStep(documents.request.requestId, {
      kind: 'human',
      email: identity.email,
    });

    // Enqueued after the commit, never inside it. A Cloud Tasks call cannot
    // join a Firestore transaction, so the durable record is what the halt or
    // the dispatch is committed against and the task is the follow-up. The
    // enqueue is idempotent on the step's idempotency key, so a repeat is
    // collapsed by Cloud Tasks rather than executing the step twice.
    //
    // The expiry hours come from the SNAPSHOT, not the live policy. The
    // snapshot is what decideStep will honour, and reading live policy here
    // would let an edit between the two produce a halt whose expiry disagrees
    // with the approval requirements it belongs to (REQ-002 AC-6, AC-7).
    const dispatch = await enqueueForStep(deps.dispatcher, documents.request.requestId, started, {
      expiryHours: resolveStepPolicy(documents.request.policySnapshot, started.step.name).expiryHours,
    });

    res.status(201).json({
      requestId: documents.request.requestId,
      phase: documents.request.phase,
      status: started.outcome === 'awaiting_approval' ? 'awaiting_approval' : 'running',
      firstStep: { stepId: started.step.stepId, status: started.step.status },
      targetUser: documents.request.targetUser,
      steps: documents.steps.map((s) => ({ stepId: s.stepId, name: s.name, status: s.status })),
      dispatch,
    });
  });

  /**
   * Approve or reject a halted step (REQ-002 AC-1 to AC-5).
   *
   * Mounted behind requireRole('approver'), so with the provisional resolver in
   * place these routes are refused for everyone. That is correct while the role
   * binding store is missing: an approval surface that admits whoever asks is
   * worse than one nobody can reach.
   *
   * The self-approval refusal is NOT enforced here. It lives in the store,
   * inside the transaction, against the persisted requester and the verified
   * identity, so it cannot be bypassed by another caller of that method.
   */
  for (const decision of ['approved', 'rejected'] as const) {
    const path = decision === 'approved' ? 'approve' : 'reject';

    router.post(`/:requestId/steps/:stepId/${path}`, requireRole('approver', authz), async (req, res) => {
      const identity = requireIdentity(req);

      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_decision',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.') || '(root)',
            message: i.message,
          })),
        });
        return;
      }

      try {
        const outcome = await deps.store.decideStep({
          requestId: req.params.requestId!,
          stepId: req.params.stepId!,
          decision,
          approver: { kind: 'human', email: identity.email },
          justification: parsed.data.justification,
        });

        // Only an approval releases work. A rejection terminates the request,
        // so there is deliberately nothing to enqueue (REQ-002 AC-4).
        const dispatch =
          outcome.stepStatus === 'ready'
            ? await tryEnqueue(() =>
                deps.dispatcher.enqueueStep({
                  requestId: req.params.requestId!,
                  stepId: req.params.stepId!,
                  idempotencyKey: outcome.idempotencyKey,
                }),
              )
            : ('not_applicable' as const);

        res.status(200).json({
          requestId: req.params.requestId,
          stepId: req.params.stepId,
          decision,
          stepStatus: outcome.stepStatus,
          requestStatus: outcome.requestStatus,
          dispatch,
        });
      } catch (err) {
        if (err instanceof SelfApprovalError) {
          // The third refusal AC-3 names, alongside the 401 and the role check.
          // Audited here rather than in the store because the store throws to
          // abort its transaction, and an audit written inside a transaction
          // that is about to roll back would be rolled back with it.
          await deps.store.recordDenied({
            requestId: req.params.requestId!,
            stepId: req.params.stepId!,
            actor: { kind: 'human', email: identity.email },
            action: 'approval.self_refused',
            reason: 'the requester may not approve their own request',
            path: req.originalUrl,
            sourceIp: req.ip ?? 'unknown',
          });
          res.status(403).json({ error: 'self_approval_refused', message: err.message });
          return;
        }
        if (err instanceof StepNotAwaitingApprovalError) {
          res.status(409).json({ error: 'not_awaiting_approval', observed: err.observed });
          return;
        }
        throw err;
      }
    });
  }

  /**
   * Hands the one-time password to the operator who asked for the account, once
   * (REQ-017), and refuses once a regeneration has replaced it (REQ-030 AC-5).
   *
   * Mounted before the '/:requestId' route below. Express matches in mount
   * order and the two paths do not collide, but keeping the more specific one
   * first means a later edit to either cannot quietly shadow this.
   *
   * The plaintext appears in the response body and nowhere else: not in the
   * path, not in a redirect, and not in any log line here.
   */
  if (deps.credentials) {
    const credentials = deps.credentials;

    router.get('/:requestId/credential', requireRole('requester', authz), async (req, res) => {
      const identity = requireIdentity(req);
      const requestId = req.params.requestId!;

      const actor = { kind: 'human' as const, email: identity.email };

      const request = await deps.store.getRequest(requestId);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      // Only the originating requester, checked against the IAP-verified
      // identity. An admin is refused too: this is the one path by which a
      // credential leaves the system, and widening it to a role rather than a
      // person would make "who could have read it" unanswerable (REQ-017 AC-1).
      if (request.requestedBy !== identity.email.toLowerCase()) {
        // Audited before the response. A refused attempt on someone else's
        // credential is exactly the event an investigation needs, and it is the
        // one an implementation is most likely to forget because nothing
        // changed (REQ-017 AC-6).
        await deps.store.recordDenied({
          requestId,
          actor,
          action: 'credential.retrieval',
          reason: 'not_the_requester',
        });
        res.status(403).json({ error: 'not_the_requester' });
        return;
      }

      // A resend reuses the credential the create request produced, so the
      // handoff document is not always keyed by the request being asked about.
      const handoffId = await deps.store.resolveCredentialRequestId(requestId);
      // The success audit is written INSIDE the claim transaction, so a crash
      // cannot destroy a ciphertext without recording who took it.
      const claimed = await credentials.retrieveOnce(handoffId, {
        actor,
        targetUser: request.targetUser,
      });

      if (!claimed) {
        // Gone: never stored, already retrieved, expired, or superseded by a
        // regeneration. One status for all four. Telling the caller which would
        // let someone who should not be here learn the account's history.
        //
        // Still audited: a second attempt and an expiry are both attempts on a
        // credential, and the trail has to show them even though the response
        // is deliberately uninformative.
        await deps.store.recordDenied({
          requestId,
          actor,
          action: 'credential.retrieval',
          reason: 'credential_unavailable',
        });
        res.status(410).json({ error: 'credential_unavailable' });
        return;
      }

      res.status(200).json({
        requestId,
        primaryEmail: claimed.primaryEmail,
        oneTimePassword: claimed.password,
      });
    });
  }

  /**
   * The full step history in one call (REQ-001 AC-5). Request, steps in
   * execution order, and the audit trail together, so an operator inspecting a
   * stuck request does not have to correlate three separate fetches.
   */
  router.get('/:requestId', requireRole('requester', authz), async (req, res) => {
    const requestId = req.params.requestId!;
    const request = await deps.store.getRequest(requestId);

    if (!request) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const [steps, audit] = await Promise.all([
      deps.store.listSteps(requestId),
      deps.store.listAudit(requestId),
    ]);

    res.status(200).json({
      request,
      steps,
      audit: audit.map((e) => ({
        eventId: e.eventId,
        stepId: e.stepId,
        action: e.action,
        actor: e.actor,
        outcome: e.outcome,
        timestamp: e.timestamp,
      })),
    });
  });

  return router;
}

/**
 * The outcome of the post-commit enqueue, reported back to the operator.
 *
 * 'deferred' is not a lie dressed up as success. The request itself is durable
 * and correct at this point; what failed is the follow-up task. Returning 500
 * would tell the operator to retry a submission that has already been admitted,
 * and their retry would come back 409 against their own request. Saying
 * 'deferred' instead states exactly what happened: the work is recorded, the
 * task is not yet scheduled, and the reconciliation sweep over steps left in
 * 'ready' with no task is what picks it up.
 */
export type DispatchOutcome = 'enqueued' | 'deferred' | 'not_applicable';

async function tryEnqueue(enqueue: () => Promise<void>): Promise<DispatchOutcome> {
  try {
    await enqueue();
    return 'enqueued';
  } catch (err) {
    logger.error({ err }, 'enqueue failed after the state was committed; left for reconciliation');
    return 'deferred';
  }
}

/**
 * Enqueues whatever the first step's outcome calls for: the execution task when
 * it was dispatched, the approver notification when it halted. The halt already
 * wrote its notification record inside the transaction, so this is the drain of
 * that record rather than the record of the intent.
 *
 * A halt with an expiry configured also schedules the expiry firing, here at
 * the halt rather than by a sweep later, so the instant the task fires at is
 * fixed the moment the waiting starts (REQ-002 AC-7). The worker's advance()
 * does the same for every later step; this covers the one halt that advance
 * never sees, the request's first step.
 */
async function enqueueForStep(
  dispatcher: TaskDispatcher,
  requestId: string,
  started: { outcome: 'dispatched' | 'awaiting_approval'; step: { stepId: string; idempotencyKey: string } },
  options: { expiryHours?: number | undefined } = {},
): Promise<DispatchOutcome> {
  if (started.outcome === 'awaiting_approval') {
    const notified = await tryEnqueue(() =>
      dispatcher.enqueueApproverNotification({ requestId, stepId: started.step.stepId }),
    );

    if (options.expiryHours && options.expiryHours > 0) {
      // Scheduled unconditionally once configured; the firing is a no-op when
      // the step was decided in time, decided transactionally in the store.
      await tryEnqueue(() =>
        dispatcher.enqueueApprovalExpiry({
          requestId,
          stepId: started.step.stepId,
          fireAt: new Date(Date.now() + options.expiryHours! * 3_600_000),
        }),
      );
    }

    return notified;
  }

  return tryEnqueue(() =>
    dispatcher.enqueueStep({
      requestId,
      stepId: started.step.stepId,
      idempotencyKey: started.step.idempotencyKey,
    }),
  );
}
