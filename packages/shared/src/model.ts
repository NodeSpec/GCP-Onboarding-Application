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

export interface ApproverNotificationRecord {
  sentAt: FirebaseFirestore.Timestamp | null;
  recipients: string[];
  deliveryId: string | null;
  error: string | null;
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
  computedDiff: Record<string, unknown> | null;
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
  startedAt: FirebaseFirestore.Timestamp | null;
  completedAt: FirebaseFirestore.Timestamp | null;
}

export interface AuditActor {
  kind: 'human' | 'system';
  email: string;
  /** For automated steps: the human whose request set the work in motion. */
  onBehalfOf?: string;
}

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
