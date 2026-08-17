import {
  ConflictingRequestError,
  InvalidPhasePayload,
  SelfApprovalError,
  StepNotAwaitingApprovalError,
  buildNewRequest,
  normalisePolicy,
  stepPlanFor,
  type ApprovalPolicy,
  type LifecycleStore,
} from '@lifecycle/shared';
import { Router } from 'express';
import { requireRole, type RoleResolver } from '../authz.js';
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
  resolver?: RoleResolver;
}

export function requestRoutes(deps: RequestRouteDeps): Router {
  const router = Router();
  const authz = { ...(deps.resolver === undefined ? {} : { resolver: deps.resolver }) };

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

    res.status(201).json({
      requestId: documents.request.requestId,
      phase: documents.request.phase,
      status: started.outcome === 'awaiting_approval' ? 'awaiting_approval' : 'running',
      firstStep: { stepId: started.step.stepId, status: started.step.status },
      targetUser: documents.request.targetUser,
      steps: documents.steps.map((s) => ({ stepId: s.stepId, name: s.name, status: s.status })),
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

        res.status(200).json({
          requestId: req.params.requestId,
          stepId: req.params.stepId,
          decision,
          stepStatus: outcome.stepStatus,
          requestStatus: outcome.requestStatus,
        });
      } catch (err) {
        if (err instanceof SelfApprovalError) {
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
