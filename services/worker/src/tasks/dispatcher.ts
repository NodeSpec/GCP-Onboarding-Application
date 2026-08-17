import { CloudTasksDispatcher, type DispatcherSettings, type TaskDispatcher } from '@lifecycle/shared';
import { config } from '../config.js';
import { logger } from '../logging.js';

/**
 * The worker's binding to the shared dispatcher.
 *
 * The enqueue logic itself moved to @lifecycle/shared, because the API service
 * enqueues onto the same queue and Cloud Tasks deduplicates on the task name.
 * Two independent derivations of that name would drift, and the symptom of the
 * drift is a step running twice with no error anywhere. What is left here is
 * the part that genuinely belongs to this service: reading its own validated
 * configuration.
 *
 * Serves REQ-013 AC-7 and REQ-016.
 */

export type { TaskDispatcher, EnqueueStepInput } from '@lifecycle/shared';

/** Reads the worker's config. Deferred, so importing this module needs no environment. */
export function dispatcherSettings(): DispatcherSettings {
  return {
    projectId: config.GCP_PROJECT_ID,
    location: config.TASKS_LOCATION,
    queue: config.TASKS_QUEUE,
    workerBaseUrl: config.WORKER_BASE_URL,
    invokerServiceAccount: config.QUEUE_INVOKER_SA,
  };
}

export function createDispatcher(): TaskDispatcher {
  return new CloudTasksDispatcher(dispatcherSettings(), { logger });
}
