import type {
  CredentialStore,
  LifecycleRequest,
  LifecycleStep,
  LifecycleStore,
} from '@lifecycle/shared';
import type { DirectoryClient } from '../workspace/directoryClient.js';

/**
 * The contract every phase step implements.
 *
 * A handler does the work and reports what happened. It does NOT move status,
 * write audit events, or decide about retries: the executor owns all three, so
 * that the transactional pairing of change and audit cannot be forgotten by one
 * handler among dozens.
 *
 * Handlers are expected to read live state first and return `skipped` when the
 * intended change already holds. That is what makes a redelivered task safe
 * even when the previous attempt timed out after the change landed (REQ-013).
 */

export interface StepContext {
  request: LifecycleRequest;
  step: LifecycleStep;
  store: LifecycleStore;
  directory: DirectoryClient;
  /**
   * Credential handling is deliberately separate from the directory client.
   * Encrypting a password and writing it to Firestore has nothing to do with
   * talking to the Directory API, and folding it in would have given the
   * Workspace client a reason to know about encryption keys.
   */
  credentials: CredentialStore;
}

export interface StepResult {
  /** `skipped` means the intended state already held; nothing was mutated. */
  status: 'succeeded' | 'skipped';
  output?: Record<string, unknown>;
}

export interface StepHandler {
  /** Matches LifecycleStep.name, and is how the registry resolves a handler. */
  readonly name: string;
  execute(ctx: StepContext): Promise<StepResult>;
}

const registry = new Map<string, StepHandler>();

export function registerHandler(handler: StepHandler): void {
  if (registry.has(handler.name)) {
    throw new Error(`Duplicate step handler registered for "${handler.name}"`);
  }
  registry.set(handler.name, handler);
}

export function resolveHandler(name: string): StepHandler {
  const handler = registry.get(name);
  if (!handler) {
    // A persisted step with no handler means the plan builder and the worker
    // have drifted apart. Fail loudly: silently skipping would report an
    // onboarding as complete having done nothing.
    throw new Error(`No handler registered for step "${name}"`);
  }
  return handler;
}

export function registeredStepNames(): string[] {
  return [...registry.keys()].sort();
}
