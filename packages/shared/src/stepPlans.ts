import { createHash } from 'node:crypto';
import type { Phase } from './model.js';

/**
 * The step plan for each phase, and the idempotency key derived from it.
 *
 * The plan lives here rather than in either service because both need it and
 * they must agree: the API service persists one step document per entry when a
 * request is created, and the worker resolves a handler by the same step name.
 * A plan that differed between them would persist steps nobody can execute.
 *
 * Group assignment is one step per group rather than one step for all of them,
 * so a single failing group does not discard the ones already applied
 * (REQ-003 AC-5) and the failure names which group.
 *
 * Serves REQ-001 and REQ-013.
 */

export interface StepPlanEntry {
  /** Matches a registered handler name in the worker. */
  name: string;
  /** Step-scoped input, snapshotted at creation. Empty for most steps. */
  input: Record<string, unknown>;
}

/** Thrown when a payload cannot produce a plan. Callers map this to 400. */
export class InvalidPhasePayload extends Error {
  constructor(
    readonly phase: Phase,
    readonly detail: string,
  ) {
    super(`Cannot build a ${phase} step plan: ${detail}`);
    this.name = 'InvalidPhasePayload';
  }
}

function groupsOf(payload: Record<string, unknown>): string[] {
  const groups = payload.groups;
  if (groups === undefined) return [];
  if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string' || g.length === 0)) {
    throw new InvalidPhasePayload('create', 'groups must be an array of non-empty strings');
  }
  return groups as string[];
}

/**
 * The ordered plan for a phase. Pure: the same payload always yields the same
 * plan, which is what makes a request's steps reproducible from its payload.
 */
export function stepPlanFor(phase: Phase, payload: Record<string, unknown>): StepPlanEntry[] {
  switch (phase) {
    case 'create':
      return [
        { name: 'validate-request', input: {} },
        { name: 'create-user', input: {} },
        { name: 'apply-attributes', input: {} },
        ...groupsOf(payload).map((groupKey) => ({ name: 'assign-group', input: { groupKey } })),
        { name: 'verify-account', input: {} },
      ];
    case 'notify':
    case 'update':
    case 'delete':
      // Phases 2 to 4 are not implemented. Refusing here is deliberate: an
      // empty plan would persist a request with no steps, which would sit in
      // 'pending' forever looking like a stuck job rather than an unbuilt one.
      throw new InvalidPhasePayload(phase, 'this phase is not implemented yet');
    default: {
      const exhaustive: never = phase;
      throw new InvalidPhasePayload(exhaustive, 'unknown phase');
    }
  }
}

/**
 * Stable JSON: object keys sorted at every depth, so two structurally equal
 * inputs hash identically regardless of the order their keys were written in.
 * Without this the key would change when a client reordered a JSON body, and
 * a retry would look like new work.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * The idempotency key for one step of one request.
 *
 * Deliberately does NOT include the attempt number. The key has to be the same
 * across retries of the same step, because that is what lets Cloud Tasks
 * deduplicate a double enqueue and what lets a handler recognise its own
 * earlier attempt. Including the attempt would give every retry a fresh key and
 * silently defeat both.
 *
 * Includes requestId and stepId, so the key is distinct across requests and
 * across steps within a request even when their inputs are identical, which is
 * the normal case: three of the five create steps carry an empty input.
 */
export function deriveIdempotencyKey(
  requestId: string,
  stepId: string,
  input: Record<string, unknown> = {},
): string {
  const digest = createHash('sha256')
    .update(canonical({ requestId, stepId, input }))
    .digest('hex')
    .slice(0, 32);
  return `${requestId}:${stepId}:${digest}`;
}
