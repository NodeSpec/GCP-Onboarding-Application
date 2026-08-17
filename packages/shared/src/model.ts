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

export interface NotificationRecord {
  sentAt: FirebaseFirestore.Timestamp | null;
  recipients: string[];
  deliveryId: string | null;
  error: string | null;
}

export type ApproverNotificationRecord = NotificationRecord;

export interface CredentialStepRecord {
  credentialRequestId: string;
  rotatedAt: FirebaseFirestore.Timestamp | null;
  supersededRequestId: string | null;
  keyVersion: string;
  expiresAt: FirebaseFirestore.Timestamp;
}

export type UpdatableAttribute =
  | 'givenName'
  | 'familyName'
  | 'title'
  | 'department'
  | 'managerEmail'
  | 'orgUnitPath';

export interface AttributeChange {
  field: UpdatableAttribute;
  before: string | null;
  after: string | null;
  changed: boolean;
}

export interface GroupChange {
  groupKey: string;
  operation: 'add' | 'remove';
  before: boolean;
  after: boolean;
  changed: boolean;
}

export interface UpdateDiff {
  targetUser: string;
  computedAt: FirebaseFirestore.Timestamp;
  attributes: AttributeChange[];
  groups: GroupChange[];
}

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
  policySnapshot: ApprovalPolicy[Phase];
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
  notification: NotificationRecord | null;
  credential: CredentialStepRecord | null;
  startedAt: FirebaseFirestore.Timestamp | null;
  completedAt: FirebaseFirestore.Timestamp | null;
}

export interface AuditActor {
  kind: 'human' | 'system' | 'anonymous';
  email: string;
  onBehalfOf?: string;
}

export const ANONYMOUS_ACTOR: AuditActor = { kind: 'anonymous', email: 'unauthenticated' };

export interface AuditEvent {
  eventId: string;
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

export interface CredentialHandoff {
  primaryEmail: string;
  oneTimePasswordCiphertext: string;
  keyVersion: string;
  retrievedAt: FirebaseFirestore.Timestamp | null;
  expiresAt: FirebaseFirestore.Timestamp;
  supersededAt?: FirebaseFirestore.Timestamp | null;
  supersededBy?: string | null;
}

export type CredentialState = 'valid' | 'superseded' | 'retrieved' | 'expired' | 'destroyed';

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

export const NON_TERMINAL_REQUEST_STATUSES: readonly RequestStatus[] = (
  ['draft', 'running', 'awaiting_approval', 'held', 'succeeded', 'failed', 'rejected', 'cancelled'] as const
).filter((s) => !TERMINAL_REQUEST_STATUSES.includes(s));
