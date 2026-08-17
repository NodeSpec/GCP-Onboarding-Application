import { CloudTasksDispatcher, type DispatcherSettings, type TaskDispatcher } from '@lifecycle/shared';
import { config } from '../config.js';
import { logger } from '../logging.js';

/**
 * The API service's binding to the shared dispatcher.
 *
 * This service enqueues the first step of a request and the approver
 * notification; the worker enqueues everything after that. Both go onto the
 * same queue, and Cloud Tasks deduplicates on the task name, so the derivation
 * has to be one implementation rather than two that happen to agree. It lives
 * in @lifecycle/shared; this file supplies the values from this service's own
 * validated configuration.
 *
 * Serves REQ-001 AC-7 and REQ-002.
 */

export type { TaskDispatcher } from '@lifecycle/shared';

/** Reads the API config. Deferred, so importing this module needs no environment. */
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
