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

export function taskRoutes(deps: ExecutorDeps): Router {
  const router = Router();

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
