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
    // Suspension is deliberately NOT gated. It is the immediate access cut and
    // the one step in this phase that can be undone, so putting an approval in
    // front of it would leave a leaver signed in until an approver happened to
    // be awake, which is the exact risk offboarding exists to close. The
    // approval belongs on the step nobody can take back.
    'delete-user': { requiresApproval: true, approverRole: 'admin' },
  },
};

/** No entry means no approval. Absent policy for a step is not an error. */
export const NO_APPROVAL: StepPolicy = { requiresApproval: false, approverRole: 'approver' };

/**
 * Steps whose approval requirement is a FLOOR rather than a default
 * (REQ-006 AC-3).
 *
 * Everything else in this file is configuration an admin can turn off. Deleting
 * a Workspace user is the one action in this system with no undo: the mailbox,
 * the Drive contents and the identity are gone, and no compensating step brings
 * them back. So the approval on it is not policy, it is a property of the
 * operation, and it is enforced where policy is READ rather than only where it
 * is written. Enforcing it on write alone would leave a document edited by any
 * other path able to disable it, and a two-party control one edit can remove is
 * not a control.
 */
export const MANDATORY_APPROVAL_STEPS: ReadonlySet<string> = new Set(['delete-user']);

/**
 * The policy for one step, read from a snapshot rather than from live policy.
 * Takes the phase slice, not the whole document, because that is what is
 * persisted on the request.
 *
 * An irreversible step comes back requiring approval whatever the snapshot
 * says, including when the snapshot says nothing at all.
 */
export function resolveStepPolicy(
  snapshot: ApprovalPolicy[Phase] | undefined,
  stepName: string,
): StepPolicy {
  const configured = snapshot?.[stepName] ?? NO_APPROVAL;
  if (!MANDATORY_APPROVAL_STEPS.has(stepName)) return configured;

  return {
    ...configured,
    requiresApproval: true,
    // An unconfigured irreversible step defaults to the higher role. Falling
    // through to NO_APPROVAL's 'approver' would quietly widen who may authorise
    // the one action nobody can take back.
    approverRole: snapshot?.[stepName]?.approverRole ?? 'admin',
  };
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
