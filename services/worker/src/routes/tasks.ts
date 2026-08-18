import { Router } from 'express';
import { z } from 'zod';
import { logger } from '../logging.js';
import { executeStep, type ExecutorDeps } from '../steps/executor.js';

/**
 * The task routes. Cloud Tasks is the only admitted caller; the router is
 * mounted behind requireCaller('cloud-tasks') in index.ts.
 *
 * The HTTP status is how Cloud Tasks learns whether to retry, so the mapping
 * from execution outcome to status code is the contract with the queue:
 *
 *   200  settled, or a duplicate delivery. Do not retry.
 *   409  the step was not claimable. Acknowledged, no side effects.
 *   500  transient. Retry with backoff until the attempt budget is spent.
 *
 * Returning 500 for a terminal failure would burn the budget re-running work
 * that cannot succeed; returning 200 for a transient one would abandon a step
 * that only needed another attempt. Both are silent, so the mapping lives here
 * in one place rather than being decided per handler.
 */

const executeBody = z.object({
  requestId: z.string().min(1),
  stepId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  attempt: z.coerce.number().int().positive().default(1),
});

const notifyBody = z.object({
  requestId: z.string().min(1),
  stepId: z.string().min(1),
});

export interface TaskRouteDeps extends ExecutorDeps {
  /** Sends the approver notice for a halted step (REQ-032). */
  notifyApprovers: (params: { requestId: string; stepId: string }) => Promise<unknown>;
  /**
   * Carries committed audit events into the tamper-evident log (REQ-018 AC-1).
   * Optional, so a deployment without the audit sink provisioned still starts;
   * the route then says it is not configured rather than reporting a sweep that
   * never happened.
   */
  sweepAuditMirror?: () => Promise<{ mirrored: number; more: boolean }>;
}

export function taskRoutes(deps: TaskRouteDeps): Router {
  const router = Router();

  /**
   * The approval expiry firing (REQ-002 AC-7). Scheduled the moment a step
   * halts, delivered by Cloud Tasks at the expiry instant, and decided entirely
   * inside the store's transaction: still pending means the request terminates
   * in 'rejected' with reason 'approval_expired'; already decided means this is
   * a no-op.
   *
   * Both outcomes are 200. A no-op firing is the task working as designed, and
   * retrying it would only produce another no-op.
   */
  router.post('/expire-approval', async (req, res) => {
    const parsed = notifyBody.safeParse(req.body);
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues }, 'malformed expire-approval task');
      res.status(200).json({ status: 'rejected', reason: 'malformed task body' });
      return;
    }

    try {
      const outcome = await deps.store.expireApproval({
        ...parsed.data,
        actor: { kind: 'system', email: 'lifecycle-worker' },
      });
      res.status(200).json({
        status: outcome.expired ? 'expired' : 'noop',
        observedStep: outcome.observedStep,
        observedRequest: outcome.observedRequest,
      });
    } catch (err) {
      // A transient Firestore failure. The step is still awaiting, so a retry
      // re-evaluates against live state and stays correct.
      logger.error({ err, ...parsed.data }, 'approval expiry failed');
      res.status(500).json({ status: 'retry' });
    }
  });

  /**
   * The approver notice. Mounted here, on the worker, because the worker holds
   * the only SMTP credential; the API service enqueues onto this route rather
   * than growing a delivery path of its own (REQ-032).
   *
   * A failure returns 500 so Cloud Tasks retries. The request itself is
   * deliberately untouched by any outcome here: the step is still awaiting
   * approval, and only the telling failed (AC-8).
   */
  router.post('/notify-approvers', async (req, res) => {
    const parsed = notifyBody.safeParse(req.body);
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues }, 'malformed notify-approvers task');
      res.status(200).json({ status: 'rejected', reason: 'malformed task body' });
      return;
    }

    try {
      const outcome = await deps.notifyApprovers(parsed.data);
      res.status(200).json({ status: 'ok', outcome });
    } catch (err) {
      // Includes NoEligibleApprover, which is retried on purpose: an admin
      // adding the missing binding is exactly the fix, and a later attempt
      // should then succeed rather than the whole request needing re-raising.
      logger.error({ err, ...parsed.data }, 'approver notification failed');
      res.status(500).json({ status: 'retry' });
    }
  });

  /**
   * The audit mirror sweep (REQ-018 AC-1), driven on a schedule rather than by
   * a request.
   *
   * It runs here, on the worker, for the same reason the approver notice does:
   * this is where scheduled background work already lives, and the API service
   * has no business growing a second one. The sweep is idempotent — the log
   * deduplicates on the audit eventId — so a redelivery costs nothing and a
   * failure is always safe to retry.
   *
   * A sweep that reports more remaining returns 200 rather than 500. The
   * backlog is not a failure, and driving it with retries would conflate
   * "there is more to do" with "this did not work"; the next scheduled firing
   * takes the next batch.
   */
  router.post('/mirror-audit', async (_req, res) => {
    if (!deps.sweepAuditMirror) {
      // Said out loud. A silent 200 here would let a deployment run for months
      // believing it had a second copy of the audit trail.
      logger.warn('audit mirror sweep requested but no mirror is configured');
      res.status(200).json({ status: 'not_configured' });
      return;
    }

    try {
      const outcome = await deps.sweepAuditMirror();
      res.status(200).json({ status: 'ok', ...outcome });
    } catch (err) {
      // The watermark does not advance past a batch the log refused, so a
      // retry re-sends the same events and the mirror catches up.
      logger.error({ err }, 'audit mirror sweep failed');
      res.status(500).json({ status: 'retry' });
    }
  });

  router.post('/execute-step', async (req, res) => {
    const parsed = executeBody.safeParse(req.body);
    if (!parsed.success) {
      // A malformed task body will never become well formed on retry.
      logger.error({ issues: parsed.error.issues }, 'malformed execute-step task');
      res.status(200).json({ status: 'rejected', reason: 'malformed task body' });
      return;
    }

    const { requestId, stepId, attempt } = parsed.data;

    try {
      const outcome = await executeStep(deps, { requestId, stepId, attempt });

      switch (outcome.kind) {
        case 'settled':
          res.status(200).json({ status: outcome.status });
          return;
        case 'not-claimable':
          res.status(409).json({ status: 'not_claimable', observed: outcome.observed });
          return;
        case 'retry':
          res.status(500).json({ status: 'retry', reason: outcome.reason });
          return;
      }
    } catch (err) {
      // An unexpected throw is treated as transient. The executor already
      // settles everything it can classify, so reaching here means something
      // outside the step failed, and those are usually worth another attempt.
      logger.error({ err, requestId, stepId }, 'unhandled failure executing step');
      res.status(500).json({ status: 'retry', reason: 'unhandled error' });
    }
  });

  return router;
}
