import { createHash } from 'node:crypto';
import { CloudTasksClient } from '@google-cloud/tasks';
import type { Logger } from 'pino';
import { logger as defaultLogger } from './logging.js';

/**
 * Enqueues work onto the lifecycle-steps queue.
 *
 * This lives in the shared package rather than in either service because BOTH
 * services enqueue onto the same queue: the API service schedules a request's
 * first step and the approver notification, the worker schedules every step
 * after that. Cloud Tasks deduplicates on the task NAME, so the two services
 * must derive that name identically or deduplication silently stops working.
 * Two copies of the derivation would agree on the day they were written and
 * drift the first time one side is edited, and the failure is invisible: no
 * error, just a step executed twice.
 *
 * Deduplication has a window rather than being permanent, so it backs up the
 * executor's transactional claim rather than replacing it.
 *
 * Configuration is injected, not imported. The two services validate their own
 * environments with their own schemas, and a shared module that reached into
 * either one could not be used by the other.
 *
 * Serves the Step Task Enqueue contract, REQ-002, REQ-016 and REQ-032.
 */

/** The five values a dispatcher needs. Both service configs carry all of them. */
export interface DispatcherSettings {
  projectId: string;
  location: string;
  queue: string;
  /** Base URL of the worker service. Also the OIDC audience. */
  workerBaseUrl: string;
  /** The identity Cloud Tasks mints a token for. The worker admits it on /tasks/*. */
  invokerServiceAccount: string;
}

/**
 * A schedule instant. Accepts a Firestore Timestamp structurally as well as a
 * Date, so callers holding either can pass it straight through and tests do not
 * need Firestore loaded to exercise scheduling.
 */
export type ScheduleAt = Date | { toMillis(): number };

export interface EnqueueStepInput {
  requestId: string;
  stepId: string;
  idempotencyKey: string;
  /** Set for the offboarding hold period. */
  scheduleAt?: ScheduleAt;
  /**
   * Set ONLY by an explicit re-dispatch of a step whose previous task already
   * executed, which today means an admin resume. Cloud Tasks remembers an
   * EXECUTED task's name for about an hour and refuses to recreate it, and the
   * dispatcher treats that refusal as successful deduplication, so a resume
   * that reused the plain name was silently swallowed: the request sat in
   * 'running' with nothing queued, forever. Found live, on the first resume
   * ever attempted. The nonce scopes the name to that one human action;
   * ordinary enqueues must never set it, or deduplication stops working.
   */
  dispatchNonce?: string;
}

export interface TaskDispatcher {
  enqueueStep(input: EnqueueStepInput): Promise<void>;
  enqueueApproverNotification(input: { requestId: string; stepId: string }): Promise<void>;
  enqueueApprovalExpiry(input: { requestId: string; stepId: string; fireAt: ScheduleAt }): Promise<void>;
}

/**
 * The discriminators, exported so they can be asserted directly.
 *
 * A step's discriminator is its idempotency key, which already excludes the
 * attempt number, so a retried enqueue of the same step collapses. The
 * notification and expiry discriminators are keyed on the step alone: one
 * notification and one expiry per step however many times a halt is retried.
 */
export const discriminators = {
  step: (idempotencyKey: string, dispatchNonce?: string): string =>
    dispatchNonce ? `execute:${idempotencyKey}:r:${dispatchNonce}` : `execute:${idempotencyKey}`,
  approverNotification: (requestId: string, stepId: string): string => `notify:${requestId}:${stepId}`,
  approvalExpiry: (requestId: string, stepId: string): string => `expire:${requestId}:${stepId}`,
} as const;

/**
 * The task resource name for a discriminator.
 *
 * Hashed rather than used raw: Cloud Tasks names allow letters, digits, hyphens
 * and underscores only, and an idempotency key contains colons. Truncating the
 * hex digest to 40 characters leaves 160 bits, which is far more than enough to
 * make a collision between two distinct steps impossible in practice.
 */
export function taskNameFor(queuePath: string, discriminator: string): string {
  const digest = createHash('sha256').update(discriminator).digest('hex').slice(0, 40);
  return `${queuePath}/tasks/${digest}`;
}

export function queuePathFor(settings: DispatcherSettings): string {
  return `projects/${settings.projectId}/locations/${settings.location}/queues/${settings.queue}`;
}

/** The slice of the Cloud Tasks client this module uses. */
export interface TaskQueueClient {
  createTask(request: { parent: string; task: Record<string, unknown> }): Promise<unknown>;
}

function adapt(client: CloudTasksClient): TaskQueueClient {
  // The generated client's request type is a deep protobuf interface. One cast
  // here, at the single point where the shapes meet, keeps it out of the rest
  // of the module and out of every test.
  return {
    createTask: (request) => client.createTask(request as Parameters<CloudTasksClient['createTask']>[0]),
  };
}

export class CloudTasksDispatcher implements TaskDispatcher {
  private readonly client: TaskQueueClient;
  private readonly queuePath: string;
  private readonly log: Logger;

  constructor(
    private readonly settings: DispatcherSettings,
    options: { client?: TaskQueueClient; logger?: Logger } = {},
  ) {
    this.client = options.client ?? adapt(new CloudTasksClient());
    this.queuePath = queuePathFor(settings);
    this.log = options.logger ?? defaultLogger;
  }

  private async enqueue(params: {
    route: string;
    body: Record<string, unknown>;
    discriminator: string;
    scheduleAt?: ScheduleAt;
  }): Promise<void> {
    const url = `${this.settings.workerBaseUrl}${params.route}`;

    try {
      await this.client.createTask({
        parent: this.queuePath,
        task: {
          name: taskNameFor(this.queuePath, params.discriminator),
          // Spread rather than assign undefined: an explicit undefined is not
          // an absent field under exactOptionalPropertyTypes.
          ...(params.scheduleAt === undefined
            ? {}
            : { scheduleTime: { seconds: epochSeconds(params.scheduleAt) } }),
          httpRequest: {
            httpMethod: 'POST',
            url,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(params.body)).toString('base64'),
            // The worker admits this identity on /tasks/* and refuses it on
            // /lookup/*. Audience is the service URL, matching taskAuth.
            oidcToken: {
              serviceAccountEmail: this.settings.invokerServiceAccount,
              audience: this.settings.workerBaseUrl,
            },
          },
        },
      });
    } catch (err) {
      // ALREADY_EXISTS means the deduplication window caught a repeat enqueue.
      // That is the mechanism working, not a failure. It is also why an
      // explicit re-dispatch of an already-executed step must carry a nonce
      // (see EnqueueStepInput.dispatchNonce): Cloud Tasks answers this same
      // code for a name whose task already RAN, and swallowing it there means
      // swallowing the delivery.
      if (isAlreadyExists(err)) {
        this.log.info(
          { route: params.route, discriminator: params.discriminator },
          'task already enqueued, skipping',
        );
        return;
      }
      throw err;
    }
  }

  async enqueueStep(input: EnqueueStepInput): Promise<void> {
    await this.enqueue({
      route: '/tasks/execute-step',
      body: {
        requestId: input.requestId,
        stepId: input.stepId,
        idempotencyKey: input.idempotencyKey,
        attempt: 1,
      },
      discriminator: discriminators.step(input.idempotencyKey, input.dispatchNonce),
      ...(input.scheduleAt === undefined ? {} : { scheduleAt: input.scheduleAt }),
    });
  }

  async enqueueApproverNotification(input: { requestId: string; stepId: string }): Promise<void> {
    await this.enqueue({
      route: '/tasks/notify-approvers',
      body: { requestId: input.requestId, stepId: input.stepId },
      discriminator: discriminators.approverNotification(input.requestId, input.stepId),
    });
  }

  async enqueueApprovalExpiry(input: {
    requestId: string;
    stepId: string;
    fireAt: ScheduleAt;
  }): Promise<void> {
    await this.enqueue({
      route: '/tasks/expire-approval',
      body: { requestId: input.requestId, stepId: input.stepId },
      discriminator: discriminators.approvalExpiry(input.requestId, input.stepId),
      scheduleAt: input.fireAt,
    });
  }
}

function epochSeconds(at: ScheduleAt): number {
  const millis = at instanceof Date ? at.getTime() : at.toMillis();
  return Math.floor(millis / 1000);
}

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 6; // gRPC ALREADY_EXISTS
}
