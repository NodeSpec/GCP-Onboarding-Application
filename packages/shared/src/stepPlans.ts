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

/**
 * The step appended when an offboarding is cancelled after suspension
 * (REQ-006 AC-4).
 *
 * Not part of any plan: it is added to a request already in flight, because by
 * the time someone cancels, the account is suspended in Workspace and putting
 * it back is a Workspace mutation. Mutations only ever happen in the executor,
 * so a cancellation has to become a step rather than a status change.
 *
 * Named here rather than in the phase module so that `advance` can recognise a
 * finished plan as cancelled rather than succeeded without importing the worker.
 */
export const COMPENSATING_STEP = 'unsuspend-user';

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

function groupListOf(phase: Phase, payload: Record<string, unknown>, field: string): string[] {
  const groups = payload[field];
  if (groups === undefined) return [];
  if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string' || g.length === 0)) {
    throw new InvalidPhasePayload(phase, `${field} must be an array of non-empty strings`);
  }
  return groups as string[];
}

/** The attribute fields phase 3 can change (REQ-005 AC-4). */
const UPDATABLE_ATTRIBUTES = [
  'givenName',
  'familyName',
  'title',
  'department',
  'managerEmail',
  'orgUnitPath',
] as const;

/**
 * Whether the payload asks for any attribute change at all.
 *
 * A present-and-null field counts. Null is a request to CLEAR the attribute,
 * which is as much a change as any other value, so a truthiness test here would
 * drop the apply step from exactly the requests that need it most.
 */
function touchesAttributes(payload: Record<string, unknown>): boolean {
  return UPDATABLE_ATTRIBUTES.some((field) => payload[field] !== undefined);
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
      // Phase 2, which is also the resend path (REQ-030): confirm the account
      // and the notification address, settle the credential, then send.
      //
      // The credential step is NAMED for what it does, and the two names are
      // distinct on purpose. Approval policy is keyed by step name, so a tenant
      // that wants two-party approval before an operator resets a real person's
      // password can require it on 'regenerate-credential' alone, without
      // putting an approval in front of every ordinary resend (AC-7).
      //
      // Sending is ONE step. Splitting render from deliver would create a step
      // that can succeed while the person still hears nothing, and a partially
      // sent letter is not a state that exists.
      return [
        { name: 'validate-notify-request', input: {} },
        payload.regenerate === true
          ? { name: 'regenerate-credential', input: {} }
          : { name: 'confirm-credential', input: {} },
        { name: 'send-welcome-letter', input: {} },
      ];
    case 'update': {
      // Phase 3 (REQ-005). Validate, then compute the diff against live state
      // and freeze it, then apply.
      //
      // The diff is its own step, ahead of everything that mutates, for two
      // reasons. An approver has to see what will actually change rather than
      // the raw payload (AC-2), which means the diff must exist before any
      // later step can halt for approval. And the apply steps read what was
      // approved rather than recomputing it, so an account that drifts between
      // approval and execution cannot quietly widen the change someone signed
      // off on.
      //
      // One step per group change, as in phase 1, so a single failing group
      // does not discard the ones already applied and the failure names which
      // group it was (AC-7).
      const adds = groupListOf(phase, payload, 'addGroups');
      const removes = groupListOf(phase, payload, 'removeGroups');
      return [
        { name: 'validate-update-request', input: {} },
        { name: 'compute-update-diff', input: {} },
        // Omitted entirely when no attribute was submitted. A step that exists
        // only to skip tells an operator a change was considered when none was
        // ever asked for.
        ...(touchesAttributes(payload) ? [{ name: 'apply-update-attributes', input: {} }] : []),
        ...adds.map((groupKey) => ({ name: 'add-group', input: { groupKey } })),
        ...removes.map((groupKey) => ({ name: 'remove-group', input: { groupKey } })),
        { name: 'verify-update', input: {} },
      ];
    }
    case 'delete':
      // Phase 4 (REQ-006). Staged and reversible until the last step.
      //
      // The ordering is the safety property, not a preference. Suspension comes
      // first because it is the immediate access cut and the only step that can
      // be undone; everything destructive happens behind it. Revocation follows
      // because a live session or an issued OAuth token outlives a suspension
      // and would otherwise keep working. Memberships go before deletion so the
      // access is gone even if a later step fails and the request stops
      // half-done. Drive transfer is last before deletion because the account
      // has to still exist to own the files being handed over.
      //
      // Memberships are ONE step rather than one per group, unlike phases 1 and
      // 3. Those act on groups an operator named; this one acts on every group
      // the account belongs to, which is not knowable at submission time and
      // which an operator should not have to enumerate to offboard someone.
      return [
        { name: 'suspend-user', input: {} },
        { name: 'revoke-access', input: {} },
        { name: 'remove-memberships', input: {} },
        ...(typeof payload.transferDriveTo === 'string' && payload.transferDriveTo.length > 0
          ? [{ name: 'transfer-drive', input: { successor: payload.transferDriveTo } }]
          : []),
        { name: 'delete-user', input: {} },
      ];
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
