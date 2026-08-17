/**
 * The Firestore data model, typed to match the "Lifecycle State Store"
 * contract. Both services import these types, so a change to the contract
 * breaks compilation in one place rather than drifting silently in two.
 */

export const COLLECTIONS = {
  requests: 'lifecycleRequests',
  steps: 'steps', // subcollection of a request
  audit: 'auditEvents',
  roleBindings: 'roleBindings',
  approvalPolicy: 'approvalPolicy',
  credentialHandoffs: 'credentialHandoffs',
} as const;

export type Phase = 'create' | 'notify' | 'update' | 'delete';

export type RequestStatus =
  | 'draft'
  | 'running'
  | 'awaiting_approval'
  | 'held'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export type StepStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type OperatorRole = 'requester' | 'approver' | 'admin';

export type StepErrorClass = 'retryable' | 'terminal' | 'validation' | 'permission';

export interface StepError {
  class: StepErrorClass;
  code: string;
  message: string;
}

export interface ApprovalRecord {
  approvedBy: string;
  decision: 'approved' | 'rejected';
  justification: string;
  at: FirebaseFirestore.Timestamp;
}

/**
 * The outcome of one outbound message, and the thing that makes sending
 * idempotent: a non-null deliveryId means the provider accepted it, so a replay
 * short-circuits instead of sending a second copy (REQ-004 AC-3, REQ-032 AC-4).
 */
export interface NotificationRecord {
  sentAt: FirebaseFirestore.Timestamp | null;
  recipients: string[];
  deliveryId: string | null;
  error: string | null;
}

/** The approver notice written when a step halts. Same shape, distinct role. */
export type ApproverNotificationRecord = NotificationRecord;

/**
 * What a step did about the one-time password, and where the retrievable copy
 * of it now lives (REQ-030).
 *
 * The pointer is the part that matters. A credential handoff document is keyed
 * by the request that produced it, and a resend is a NEW request with a new id,
 * so without this the operator retrieving "the credential for this request"
 * would find nothing on a resend that reused the original credential. Recording
 * the pointer on the step keeps the request document unchanged and gives
 * retrieval a single place to look.
 */
export interface CredentialStepRecord {
  /** The credentialHandoffs document id holding the retrievable ciphertext. */
  credentialRequestId: string;
  /** Set only when this step generated a new password (REQ-030 AC-4). */
  rotatedAt: FirebaseFirestore.Timestamp | null;
  /** The record this rotation invalidated, if there was one. */
  supersededRequestId: string | null;
  keyVersion: string;
  expiresAt: FirebaseFirestore.Timestamp;
}

/**
 * The attributes phase 3 can change (REQ-005 AC-4).
 *
 * This list IS the recorded interpretation of "role": the fields that describe
 * what someone does, alongside the group memberships that grant them access.
 * Workspace ADMIN role assignment is deliberately absent here, from the
 * Directory scopes, and from the custom admin role, because a service account
 * that can assign admin roles can make itself Super Admin (AC-9).
 */
export type UpdatableAttribute =
  | 'givenName'
  | 'familyName'
  | 'title'
  | 'department'
  | 'managerEmail'
  | 'orgUnitPath';

/**
 * One requested attribute change, resolved against live Workspace state.
 *
 * `changed` is carried rather than left for the reader to derive, because null
 * and absence are both meaningful: clearing a title is a real change from
 * 'Engineer' to null, and a title that is already absent is not. A consumer
 * comparing before to after would have to reimplement that distinction, and the
 * approval view and the apply step must not disagree about it.
 */
export interface AttributeChange {
  field: UpdatableAttribute;
  before: string | null;
  after: string | null;
  /** False when the requested value already matches live state (AC-5). */
  changed: boolean;
}

/** One requested membership change, resolved against live state. */
export interface GroupChange {
  groupKey: string;
  operation: 'add' | 'remove';
  /** Whether the user is a member at the moment the diff was computed. */
  before: boolean;
  after: boolean;
  changed: boolean;
}

/**
 * What a phase 3 request will actually do, computed against the account as it
 * stands and frozen onto the request before anything is applied (AC-1).
 *
 * Every requested change appears here, including the ones that turn out to be
 * no-ops, because an approver needs to see what was asked for as well as what
 * will happen. Filtering the no-ops out would leave an approval screen that
 * silently disagrees with the request it is approving.
 */
export interface UpdateDiff {
  targetUser: string;
  computedAt: FirebaseFirestore.Timestamp;
  attributes: AttributeChange[];
  groups: GroupChange[];
}

/** Per-step approval configuration, frozen onto a request at creation. */
export interface StepPolicy {
  requiresApproval: boolean;
  approverRole: 'approver' | 'admin';
  expiryHours?: number;
}

export type ApprovalPolicy = Record<Phase, Record<string, StepPolicy>>;

export interface LifecycleRequest {
  requestId: string;
  phase: Phase;
  status: RequestStatus;
  targetUser: string;
  requestedBy: string;
  payload: Record<string, unknown>;
  /**
   * The policy in force when this request was created. Read from here, never
   * from live configuration, so a policy edit cannot change the approval
   * requirements of a request already in flight (REQ-002).
   */
  policySnapshot: ApprovalPolicy[Phase];
  /**
   * What this request will change, resolved against live Workspace state.
   * Null on every phase that is not an update, and null on an update until its
   * diff step has run (REQ-005 AC-1).
   */
  computedDiff: UpdateDiff | null;
  holdUntil: FirebaseFirestore.Timestamp | null;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export interface LifecycleStep {
  stepId: string;
  name: string;
  ordinal: number;
  status: StepStatus;
  attempts: number;
  requiresApproval: boolean;
  idempotencyKey: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: StepError | null;
  approval: ApprovalRecord | null;
  approverNotification: ApproverNotificationRecord | null;
  /**
   * The message this step itself sent, for steps whose work IS sending: the
   * welcome letter (REQ-004). Kept separate from approverNotification, which
   * records the notice about a halt rather than the step's own output, so a
   * replay of either can short-circuit on its own record.
   */
  notification: NotificationRecord | null;
  /**
   * What this step did about the one-time password: confirmed an existing one
   * is still retrievable, or rotated it (REQ-030). Null on every step whose
   * work has nothing to do with the credential, which is most of them.
   */
  credential: CredentialStepRecord | null;
  startedAt: FirebaseFirestore.Timestamp | null;
  completedAt: FirebaseFirestore.Timestamp | null;
}

export interface AuditActor {
  kind: 'human' | 'system' | 'anonymous';
  email: string;
  /** For automated steps: the human whose request set the work in motion. */
  onBehalfOf?: string;
}

/**
 * The actor for a refusal where nothing about the caller was ever verified: a
 * 401 from assertion verification (REQ-010 AC-3).
 *
 * Recording a claimed identity here would be worse than recording none. The
 * assertion did not verify, so any email in it is a string an attacker chose,
 * and writing it into the trail would let them forge attribution for their own
 * failed attempts. What IS known is the path and the source IP, which
 * recordDenied carries alongside.
 */
export const ANONYMOUS_ACTOR: AuditActor = { kind: 'anonymous', email: 'unauthenticated' };

export interface AuditEvent {
  eventId: string;
  /**
   * Null for events that are not about a lifecycle request. A role binding
   * change is the case that forced this: it is a real audited action with an
   * actor and a subject, but no request to hang it on, and inventing a sentinel
   * request id would have made the per-request audit query lie.
   */
  requestId: string | null;
  stepId: string | null;
  actor: AuditActor;
  action: string;
  targetUser: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  outcome: 'success' | 'failure' | 'denied';
  timestamp: FirebaseFirestore.Timestamp;
}

export interface RoleBinding {
  kind: 'user' | 'group';
  roles: OperatorRole[];
  updatedBy: string;
  updatedAt: FirebaseFirestore.Timestamp;
}

/**
 * The one-time password between generation and operator retrieval. Encrypted,
 * never hashed: the operator has to recover the real value, and a hash cannot
 * be reversed (REQ-019).
 */
export interface CredentialHandoff {
  primaryEmail: string;
  oneTimePasswordCiphertext: string;
  keyVersion: string;
  retrievedAt: FirebaseFirestore.Timestamp | null;
  expiresAt: FirebaseFirestore.Timestamp;
  /**
   * Set when a regeneration replaced this record (REQ-030 AC-4). The old
   * ciphertext is emptied at the same time, so the flag is a reason rather than
   * the enforcement: retrieval refuses on either.
   *
   * Optional on read because records written before regeneration existed carry
   * neither field. Treat an absent value as null rather than as unset.
   */
  supersededAt?: FirebaseFirestore.Timestamp | null;
  supersededBy?: string | null;
}

/**
 * Why a credential cannot be handed over. Ordered from most to least specific,
 * which is the order `credentialState` tests them in: a superseded record has
 * usually also been emptied, and reporting "destroyed" there would hide the
 * fact that a regeneration is the reason.
 */
export type CredentialState = 'valid' | 'superseded' | 'retrieved' | 'expired' | 'destroyed';

/**
 * Whether a stored credential can still be handed to an operator.
 *
 * Shared by the resend precondition (REQ-030 AC-3) and by retrieval itself
 * (REQ-017), so the two cannot disagree about what "still valid" means. Pure,
 * and takes `now` explicitly, so the expiry boundary is testable without
 * waiting for a TTL.
 */
export function credentialState(record: CredentialHandoff, now: number): CredentialState {
  if ((record.supersededAt ?? null) !== null) return 'superseded';
  if (record.retrievedAt !== null) return 'retrieved';
  if (record.expiresAt.toMillis() <= now) return 'expired';
  if (record.oneTimePasswordCiphertext === '') return 'destroyed';
  return 'valid';
}

export const TERMINAL_REQUEST_STATUSES: readonly RequestStatus[] = [
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
];

export function isTerminalRequestStatus(status: RequestStatus): boolean {
  return TERMINAL_REQUEST_STATUSES.includes(status);
}

/**
 * The statuses that make a request "in flight". Derived from the terminal list
 * rather than written out, so adding a status to RequestStatus cannot silently
 * leave it out of the concurrency guard (REQ-001 AC-2).
 */
export const NON_TERMINAL_REQUEST_STATUSES: readonly RequestStatus[] = (
  ['draft', 'running', 'awaiting_approval', 'held', 'succeeded', 'failed', 'rejected', 'cancelled'] as const
).filter((s) => !TERMINAL_REQUEST_STATUSES.includes(s));
