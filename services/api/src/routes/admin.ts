import { Timestamp } from '@google-cloud/firestore';
import {
  InvalidTransitionError,
  type ApprovalPolicy,
  type LifecycleStore,
  type TaskDispatcher,
} from '@lifecycle/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type RoleResolver } from '../authz.js';
import { logger } from '../logging.js';
import { requireIdentity } from '../middleware/iapAuth.js';

/**
 * The admin surface: edit approval policy, cancel or resume any request, and
 * read the full audit trail (REQ-012 AC-5).
 *
 * These are the three powers that distinguish admin from approver, and each is
 * a power over other people's work, so every one of them writes an audit event
 * naming the actor. The audit read is here rather than on the request routes
 * because it spans every request: a requester can already see the trail for a
 * request they can fetch, and that is as far as their reach should go.
 */

export interface AdminRouteDeps {
  store: LifecycleStore;
  /** Enqueues the step a resume releases. */
  dispatcher: TaskDispatcher;
  resolver?: RoleResolver;
  /** Called after a policy edit so a caller can drop anything it cached. */
  onPolicyChanged?: () => void;
}

const stepPolicySchema = z
  .object({
    requiresApproval: z.boolean(),
    approverRole: z.enum(['approver', 'admin']),
    expiryHours: z.number().int().positive().max(24 * 30).optional(),
  })
  .strict();

/**
 * Every phase must be present. A partial document would leave a phase resolving
 * to the built-in default, which for the delete phase means approval is
 * required; an admin who meant to relax it and silently did not would find out
 * at the worst moment. Making it explicit forces the intent to be stated.
 */
const policySchema = z
  .object({
    create: z.record(stepPolicySchema),
    notify: z.record(stepPolicySchema),
    update: z.record(stepPolicySchema),
    delete: z.record(stepPolicySchema),
  })
  .strict();

/**
 * Rebuilds the policy with absent optionals actually absent.
 *
 * Under exactOptionalPropertyTypes an explicit `expiryHours: undefined` is not
 * the same as an omitted one, and zod produces the former. Firestore would also
 * reject the undefined outright, so this is not only a type concern.
 */
function toPolicy(parsed: z.infer<typeof policySchema>): ApprovalPolicy {
  const phases = ['create', 'notify', 'update', 'delete'] as const;
  const out = {} as ApprovalPolicy;

  for (const phase of phases) {
    out[phase] = Object.fromEntries(
      Object.entries(parsed[phase]).map(([step, policy]) => [
        step,
        {
          requiresApproval: policy.requiresApproval,
          approverRole: policy.approverRole,
          ...(policy.expiryHours === undefined ? {} : { expiryHours: policy.expiryHours }),
        },
      ]),
    );
  }

  return out;
}

const reasonSchema = z
  .object({ reason: z.string().trim().min(1, 'a reason is required').max(2000) })
  .strict();

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  before: z.coerce.number().int().positive().optional(),
});

export function adminRoutes(deps: AdminRouteDeps): Router {
  const router = Router();
  const authz = { ...(deps.resolver === undefined ? {} : { resolver: deps.resolver }) };
  const admin = () => requireRole('admin', authz);

  router.get('/approval-policy', admin(), async (_req, res) => {
    res.status(200).json({ policy: await deps.store.getApprovalPolicy() });
  });

  router.put('/approval-policy', admin(), async (req, res) => {
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_policy',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      });
      return;
    }

    const identity = requireIdentity(req);
    const outcome = await deps.store.setApprovalPolicy({
      policy: toPolicy(parsed.data),
      actor: { kind: 'human', email: identity.email },
    });

    deps.onPolicyChanged?.();

    // Requests already in flight are untouched by design: each carries the
    // snapshot it took at creation (REQ-002 AC-6). Saying so in the response
    // stops an admin believing an edit reached work already under way.
    res.status(200).json({
      policy: outcome.after,
      previousPolicy: outcome.before,
      appliesTo: 'requests created from now on; in-flight requests keep their snapshot',
    });
  });

  router.post('/requests/:requestId/cancel', admin(), async (req, res) => {
    const parsed = reasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_reason',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      });
      return;
    }

    const identity = requireIdentity(req);

    try {
      const outcome = await deps.store.cancelRequest({
        requestId: req.params.requestId!,
        actor: { kind: 'human', email: identity.email },
        reason: parsed.data.reason,
      });

      if (!outcome.cancelled) {
        res.status(409).json({ error: 'already_terminal', observed: outcome.observed });
        return;
      }

      res.status(200).json({
        requestId: req.params.requestId,
        status: 'cancelled',
        stepsStopped: outcome.skippedSteps,
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        res.status(409).json({ error: 'illegal_transition', message: err.message });
        return;
      }
      throw err;
    }
  });

  router.post('/requests/:requestId/resume', admin(), async (req, res) => {
    const identity = requireIdentity(req);

    const outcome = await deps.store.resumeRequest({
      requestId: req.params.requestId!,
      actor: { kind: 'human', email: identity.email },
    });

    if (!outcome.resumed || !outcome.step) {
      res.status(409).json({ error: 'not_resumable', observed: outcome.observed });
      return;
    }

    // Enqueued after the commit, as everywhere else. The idempotency key is
    // unchanged across attempts, so a resume of a step whose task is somehow
    // still in the queue collapses onto the same task rather than doubling it.
    let dispatch: 'enqueued' | 'deferred' = 'enqueued';
    try {
      await deps.dispatcher.enqueueStep({
        requestId: req.params.requestId!,
        stepId: outcome.step.stepId,
        idempotencyKey: outcome.step.idempotencyKey,
      });
    } catch (err) {
      logger.error({ err }, 'resume committed but the enqueue failed; left for reconciliation');
      dispatch = 'deferred';
    }

    res.status(200).json({
      requestId: req.params.requestId,
      status: 'running',
      resumedStep: outcome.step.stepId,
      dispatch,
    });
  });

  router.get('/audit', admin(), async (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query' });
      return;
    }

    const events = await deps.store.listAllAudit({
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
      ...(parsed.data.before === undefined
        ? {}
        : { before: Timestamp.fromMillis(parsed.data.before) }),
    });

    res.status(200).json({
      // Timestamps go out as ISO strings. Serialising a Firestore Timestamp
      // directly leaks its internal _seconds/_nanoseconds encoding onto the
      // wire, which every client would then have to know how to decode.
      events: events.map((e) => ({ ...e, timestamp: e.timestamp.toDate().toISOString() })),
      // The cursor for the next page, so a caller does not have to know that
      // paging is by timestamp.
      nextBefore: events.at(-1)?.timestamp.toMillis() ?? null,
    });
  });

  return router;
}
