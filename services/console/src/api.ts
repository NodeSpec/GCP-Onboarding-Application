import type { Phase } from '@lifecycle/schemas';

/**
 * The console's only route to the server.
 *
 * Every call is a same-origin fetch with credentials, because the console is
 * served by the API service behind IAP: the assertion travels as the browser's
 * IAP cookie and this code never sees, holds, or forwards a token. That is the
 * whole reason the console is served from the API origin rather than a static
 * bucket (REQ-011 AC-8, REQ-032 AC-6).
 *
 * There is deliberately no client-side auth state here. Who the operator is and
 * what they may do comes from GET /api/me on every load; nothing is inferred
 * from a claim the client could edit.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `request failed with ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** Field-level issues from a 400, when the server sent them. */
  get issues(): { path: string; message: string }[] {
    const b = this.body as { issues?: { path: string; message: string }[] } | null;
    return Array.isArray(b?.issues) ? b!.issues! : [];
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // Same-origin: the IAP cookie rides along and nothing else is attached.
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  const text = await res.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// ---------------------------------------------------------------- identity

export type OperatorRole = 'requester' | 'approver' | 'admin';

export interface Identity {
  email: string;
  subject: string;
  roles: OperatorRole[];
}

/** AC-8: who the operator is, answered by the server from the IAP assertion. */
export const getIdentity = () => request<Identity>('/api/me');

// ---------------------------------------------------------------- requests

export type RequestStatus =
  | 'draft'
  | 'running'
  | 'awaiting_approval'
  | 'held'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export interface RequestSummary {
  requestId: string;
  phase: Phase;
  status: RequestStatus;
  targetUser: string;
  requestedBy: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface RequestPage {
  requests: RequestSummary[];
  nextCursor: string | null;
}

export interface ListFilters {
  phase?: Phase | '';
  status?: RequestStatus | '';
  targetUser?: string;
  cursor?: string | null;
  limit?: number;
}

/** AC-4: filters and paging are the server's job; this only forwards them. */
export function listRequests(filters: ListFilters = {}): Promise<RequestPage> {
  const q = new URLSearchParams();
  if (filters.phase) q.set('phase', filters.phase);
  if (filters.status) q.set('status', filters.status);
  if (filters.targetUser) q.set('targetUser', filters.targetUser);
  if (filters.cursor) q.set('cursor', filters.cursor);
  if (filters.limit) q.set('limit', String(filters.limit));
  const qs = q.toString();
  return request<RequestPage>(`/api/requests${qs ? `?${qs}` : ''}`);
}

export interface StepView {
  stepId: string;
  name: string;
  ordinal: number;
  status: string;
  attempts: number;
  requiresApproval: boolean;
  error: { class: string; code: string; message: string } | null;
  startedAt: { _seconds?: number } | null;
  completedAt: { _seconds?: number } | null;
}

export interface AttributeChange {
  field: string;
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
  attributes: AttributeChange[];
  groups: GroupChange[];
}

export interface RequestDetail {
  request: RequestSummary & { computedDiff: UpdateDiff | null; payload?: Record<string, unknown> };
  steps: StepView[];
  audit: { eventId: string; action: string; actor: { email: string }; outcome: string }[];
}

export const getRequest = (requestId: string) =>
  request<RequestDetail>(`/api/requests/${encodeURIComponent(requestId)}`);

export const submitRequest = (phase: Phase, payload: Record<string, unknown>) =>
  request<{ requestId: string }>('/api/requests', {
    method: 'POST',
    body: JSON.stringify({ phase, payload }),
  });

export const decideStep = (
  requestId: string,
  stepId: string,
  decision: 'approve' | 'reject',
  justification: string,
) =>
  request<{ stepStatus: string }>(
    `/api/requests/${encodeURIComponent(requestId)}/steps/${encodeURIComponent(stepId)}/${decision}`,
    { method: 'POST', body: JSON.stringify({ justification }) },
  );

export const cancelRequest = (requestId: string, reason: string) =>
  request<{ status: string }>(`/api/requests/${encodeURIComponent(requestId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });

// ---------------------------------------------------------------- approvals

export interface InboxEntry {
  requestId: string;
  phase: Phase;
  targetUser: string;
  requestedBy: string;
  step: { stepId: string; name: string; requiredRole: OperatorRole };
  computedDiff: UpdateDiff | null;
}

/** AC-6: the server decides eligibility; the console does not filter it again. */
export const getApprovals = () =>
  request<{ approvals: InboxEntry[] }>('/api/requests/inbox/approvals');

// ------------------------------------------------------------------ lookup

export interface UserHit {
  primaryEmail: string;
  fullName: string;
  orgUnitPath: string;
  suspended: boolean;
}

export interface UserDetail {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  orgUnitPath: string;
  suspended: boolean;
  title: string | null;
  department: string | null;
  managerEmail: string | null;
  groups: string[];
}

export const searchUsers = (q: string) =>
  request<{ users: UserHit[] }>(`/api/lookup/users?q=${encodeURIComponent(q)}`);

export const getUser = (primaryEmail: string) =>
  request<UserDetail>(`/api/lookup/users/${encodeURIComponent(primaryEmail)}`);

export const listGroups = () =>
  request<{ groups: { email: string; name: string }[] }>('/api/lookup/groups');

export const listOrgUnits = () =>
  request<{ orgUnits: { orgUnitPath: string; name: string }[] }>('/api/lookup/org-units');
