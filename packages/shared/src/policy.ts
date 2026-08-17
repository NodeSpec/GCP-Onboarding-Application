import { COLLECTIONS, type ApprovalPolicy, type Phase, type StepPolicy } from './model.js';

/**
 * Approval policy: which steps need a second pair of eyes, and who may give it.
 *
 * The policy lives in Firestore rather than in configuration because REQ-012
 * gives admins the ability to edit it at runtime, and a config artifact would
 * need a redeploy for that. It is READ at request-creation time and snapshotted
 * onto the request (REQ-002 AC-6), so an edit never retroactively changes the
 * approval requirements of a request already in flight.
 *
 * Serves REQ-002.
 */

export const POLICY_DOC_ID = 'current';

/**
 * The fallback when no policy document exists.
 *
 * Deliberately requires approval on the destructive steps rather than defaulting
 * to open. A missing policy document is far more likely to mean "not configured
 * yet" than "approval intentionally disabled", and the safe reading of an
 * absent control is that the control applies.
 */
export const DEFAULT_POLICY: ApprovalPolicy = {
  create: {
    'create-user': { requiresApproval: false, approverRole: 'approver' },
  },
  notify: {},
  update: {
    'apply-attributes': { requiresApproval: true, approverRole: 'approver' },
  },
  delete: {
    'suspend-user': { requiresApproval: true, approverRole: 'admin' },
    'delete-user': { requiresApproval: true, approverRole: 'admin' },
  },
};

/** No entry means no approval. Absent policy for a step is not an error. */
export const NO_APPROVAL: StepPolicy = { requiresApproval: false, approverRole: 'approver' };

/**
 * The policy for one step, read from a snapshot rather than from live policy.
 * Takes the phase slice, not the whole document, because that is what is
 * persisted on the request.
 */
export function resolveStepPolicy(
  snapshot: ApprovalPolicy[Phase] | undefined,
  stepName: string,
): StepPolicy {
  return snapshot?.[stepName] ?? NO_APPROVAL;
}

/** True when any step in the plan will halt for approval. */
export function planRequiresApproval(
  snapshot: ApprovalPolicy[Phase] | undefined,
  stepNames: readonly string[],
): boolean {
  return stepNames.some((name) => resolveStepPolicy(snapshot, name).requiresApproval);
}

/**
 * Narrows a stored document to the policy shape, filling missing phases.
 * A partially written policy document must not make a phase unresolvable.
 */
export function normalisePolicy(raw: unknown): ApprovalPolicy {
  const source = (raw ?? {}) as Partial<ApprovalPolicy>;
  return {
    create: source.create ?? DEFAULT_POLICY.create,
    notify: source.notify ?? DEFAULT_POLICY.notify,
    update: source.update ?? DEFAULT_POLICY.update,
    delete: source.delete ?? DEFAULT_POLICY.delete,
  };
}

/** Where the policy document lives, so callers do not hardcode the path. */
export function policyPath(): string {
  return `${COLLECTIONS.approvalPolicy}/${POLICY_DOC_ID}`;
}
