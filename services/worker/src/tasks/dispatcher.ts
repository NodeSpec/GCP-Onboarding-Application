import { CloudTasksClient } from '@google-cloud/tasks';
import type { Timestamp } from '@google-cloud/firestore';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logging.js';

/**
 * Enqueues work onto the lifecycle-steps queue.
 *
 * Both services enqueue: the API service for a request's first step, the worker
 * for every step after it. The queue carries three task types, all reaching the
 * worker with an OIDC token issued to the queue's invoker service account.
 *
 * The important property here is the task NAME. Cloud Tasks deduplicates on it,
 * so deriving the name from the step's idempotency key means a double enqueue,
 * from a retried transaction or two racing deliveries, collapses to one task
 * rather than executing the step twice. Deduplication has a window rather than
 * being permanent, which is why it backs up the executor's transactional claim
 * rather than replacing it.
 *
 * Serves the Step Task Enqueue contract, REQ-016 and REQ-032.
 */

export interface EnqueueStepInput {
  requestId: string;
  stepId: string;
  idempotencyKey: string;
  /** Set for the offboarding hold period. */
  scheduleAt?: Timestamp;
}

export interface TaskDispatcher {
  enqueueStep(input: EnqueueStepInput): Promise<void>;
  enqueueApproverNotification(input: { requestId: string; stepId: string }): Promise<void>;
  enqueueApprovalExpiry(input: { requestId: string; stepId: string; fireAt: Timestamp }): Promise<void>;
}

/** Cloud Tasks names allow letters, digits, hyphens and underscores only. */
function taskName(queuePath: string, discriminator: string): string {
  const digest = createHash('sha256').update(discriminator).digest('hex').slice(0, 40);
  return `${queuePath}/tasks/${digest}`;
}

export class CloudTasksDispatcher implements TaskDispatcher {
  private readonly client = new CloudTasksClient();
  private readonly queuePath: string;

  constructor() {
    this.queuePath = this.client.queuePath(
      config.GCP_PROJECT_ID,
      config.TASKS_LOCATION,
      config.TASKS_QUEUE,
    );
  }

  private async enqueue(params: {
    route: string;
    body: Record<string, unknown>;
    discriminator: string;
    scheduleAt?: Timestamp;
  }): Promise<void> {
    const url = `${config.WORKER_BASE_URL}${params.route}`;

    try {
      await this.client.createTask({
        parent: this.queuePath,
        task: {
          name: taskName(this.queuePath, params.discriminator),
          // Spread rather than assign undefined: an explicit undefined is not
          // an absent field under exactOptionalPropertyTypes.
          ...(params.scheduleAt
            ? { scheduleTime: { seconds: Math.floor(params.scheduleAt.toMillis() / 1000) } }
            : {}),
          httpRequest: {
            httpMethod: 'POST',
            url,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(params.body)).toString('base64'),
            // The worker admits this identity on /tasks/* and refuses it on
            // /lookup/*. Audience is the service URL, matching taskAuth.
            oidcToken: {
              serviceAccountEmail: config.QUEUE_INVOKER_SA,
              audience: config.WORKER_BASE_URL,
            },
          },
        },
      });
    } catch (err) {
      // ALREADY_EXISTS means the deduplication window caught a repeat enqueue.
      // That is the mechanism working, not a failure.
      if (isAlreadyExists(err)) {
        logger.info({ route: params.route, discriminator: params.discriminator }, 'task already enqueued, skipping');
        return;
      }
      throw err;
    }
  }

  async enqueueStep(input: EnqueueStepInput): Promise<void> {
    await this.enqueue({
      route: '/tasks/execute-step',
      body: { requestId: input.requestId, stepId: input.stepId, idempotencyKey: input.idempotencyKey, attempt: 1 },
      discriminator: `execute:${input.idempotencyKey}`,
      ...(input.scheduleAt === undefined ? {} : { scheduleAt: input.scheduleAt }),
    });
  }

  async enqueueApproverNotification(input: { requestId: string; stepId: string }): Promise<void> {
    await this.enqueue({
      route: '/tasks/notify-approvers',
      body: input,
      // One notification per step, no matter how many times a halt is retried.
      discriminator: `notify:${input.requestId}:${input.stepId}`,
    });
  }

  async enqueueApprovalExpiry(input: { requestId: string; stepId: string; fireAt: Timestamp }): Promise<void> {
    await this.enqueue({
      route: '/tasks/expire-approval',
      body: { requestId: input.requestId, stepId: input.stepId },
      discriminator: `expire:${input.requestId}:${input.stepId}`,
      scheduleAt: input.fireAt,
    });
  }
}

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 6; // gRPC ALREADY_EXISTS
}
