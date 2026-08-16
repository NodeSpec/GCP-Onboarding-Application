import { randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { google, type admin_directory_v1 } from 'googleapis';
import { logger } from '../logging.js';

/**
 * The single construction site for Workspace credentials, and the single choke
 * point for retry and error classification. No phase handler builds its own
 * client and no phase handler implements its own retry.
 *
 * Authentication model, which is the part most likely to be changed by mistake:
 * the service account acts AS ITSELF, holding a Workspace administrator role
 * assigned directly to it in the Admin console. There is no `subject` parameter
 * anywhere below, no downloaded key file, and no Domain-Wide Delegation. If you
 * find yourself adding an impersonation subject to make something work, the
 * grant is wrong, not the code.
 *
 * Serves REQ-008 and REQ-013. Read-only methods additionally serve REQ-029.
 */

export const DIRECTORY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.group.member',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
] as const;

export type ErrorClass = 'retryable' | 'terminal' | 'permission' | 'conflict' | 'not_found';

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    readonly status: number | undefined,
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

export class AdminRoleNotGrantedError extends WorkspaceError {
  constructor(operation: string, detail: string, options?: { cause?: unknown }) {
    super(
      `Workspace refused ${operation} with 403. The service account is missing a privilege on its ` +
        `custom admin role. Check Admin console > Account > Admin roles. Detail: ${detail}`,
      'permission',
      403,
      operation,
      options,
    );
    this.name = 'AdminRoleNotGrantedError';
  }
}

function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const candidate = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
    for (const value of [candidate.code, candidate.status, candidate.response?.status]) {
      if (typeof value === 'number') return value;
    }
  }
  return undefined;
}

function retryAfterSeconds(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const headers = (err as { response?: { headers?: Record<string, unknown> } }).response?.headers;
    const raw = headers?.['retry-after'];
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

export function classify(status: number | undefined): ErrorClass {
  if (status === undefined) return 'retryable';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'retryable';
  if (status >= 500) return 'retryable';
  return 'terminal';
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 20_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number, policy: RetryPolicy): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.random() * ceiling;
}

export interface InsertUserInput {
  primaryEmail: string;
  name: { givenName: string; familyName: string };
  password: string;
  changePasswordAtNextLogin: boolean;
  orgUnitPath: string;
}

export interface UserSummary {
  primaryEmail: string;
  fullName: string;
  orgUnitPath: string;
  suspended: boolean;
}

export class DirectoryClient {
  private readonly auth: GoogleAuth;
  private readonly retry: RetryPolicy;
  private readonly customerId: string;
  private api: admin_directory_v1.Admin | undefined;

  constructor(options: { customerId: string; retry?: RetryPolicy }) {
    // Application Default Credentials from the Cloud Run metadata server.
    // No keyFile, no credentials object, no subject.
    this.auth = new GoogleAuth({ scopes: [...DIRECTORY_SCOPES] });
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.customerId = options.customerId;
  }

  private async client(): Promise<admin_directory_v1.Admin> {
    if (!this.api) {
      this.api = google.admin({ version: 'directory_v1', auth: this.auth });
    }
    return this.api;
  }

  async call<T>(operation: string, fn: (api: admin_directory_v1.Admin) => Promise<T>): Promise<T> {
    const api = await this.client();
    let lastError: unknown;

    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt += 1) {
      try {
        return await fn(api);
      } catch (err) {
        lastError = err;
        const status = statusOf(err);
        const errorClass = classify(status);
        const detail = err instanceof Error ? err.message : String(err);

        if (errorClass === 'permission') {
          throw new AdminRoleNotGrantedError(operation, detail, { cause: err });
        }
        if (errorClass !== 'retryable') {
          throw new WorkspaceError(
            `Workspace ${operation} failed with ${status ?? 'unknown status'}: ${detail}`,
            errorClass,
            status,
            operation,
            { cause: err },
          );
        }

        if (attempt === this.retry.maxAttempts - 1) break;

        const honoured = retryAfterSeconds(err);
        const delay = honoured !== undefined ? honoured * 1000 : backoffMs(attempt, this.retry);
        logger.warn(
          { operation, status, attempt: attempt + 1, delayMs: Math.round(delay) },
          'retrying Workspace call',
        );
        await sleep(delay);
      }
    }

    throw new WorkspaceError(
      `Workspace ${operation} exhausted ${this.retry.maxAttempts} attempts`,
      'retryable',
      statusOf(lastError),
      operation,
      { cause: lastError },
    );
  }

  // ---------------------------------------------------------------- users

  /** Returns null on 404 so callers can ask "is this already true?". */
  async getUser(primaryEmail: string): Promise<admin_directory_v1.Schema$User | null> {
    try {
      const res = await this.call('users.get', (api) => api.users.get({ userKey: primaryEmail }));
      return res.data;
    } catch (err) {
      if (err instanceof WorkspaceError && err.errorClass === 'not_found') return null;
      throw err;
    }
  }

  async insertUser(input: InsertUserInput): Promise<admin_directory_v1.Schema$User> {
    const res = await this.call('users.insert', (api) =>
      api.users.insert({
        requestBody: {
          primaryEmail: input.primaryEmail,
          name: input.name,
          password: input.password,
          changePasswordAtNextLogin: input.changePasswordAtNextLogin,
          orgUnitPath: input.orgUnitPath,
        },
      }),
    );
    return res.data;
  }

  async updateUser(
    primaryEmail: string,
    patch: admin_directory_v1.Schema$User,
  ): Promise<admin_directory_v1.Schema$User> {
    const res = await this.call('users.update', (api) =>
      api.users.update({ userKey: primaryEmail, requestBody: patch }),
    );
    return res.data;
  }

  async setSuspended(primaryEmail: string, suspended: boolean): Promise<void> {
    await this.call('users.update.suspended', (api) =>
      api.users.update({ userKey: primaryEmail, requestBody: { suspended } }),
    );
  }

  /** Idempotent: a user already absent resolves as satisfied (REQ-006). */
  async deleteUser(primaryEmail: string): Promise<{ deleted: boolean }> {
    try {
      await this.call('users.delete', (api) => api.users.delete({ userKey: primaryEmail }));
      return { deleted: true };
    } catch (err) {
      if (err instanceof WorkspaceError && err.errorClass === 'not_found') {
        return { deleted: false };
      }
      throw err;
    }
  }

  /** Prefix search for the operator picker. Read only (REQ-029). */
  async searchUsers(query: string, limit = 25, pageToken?: string): Promise<{ users: UserSummary[]; nextPageToken?: string }> {
    const res = await this.call('users.list', (api) =>
      api.users.list({
        customer: this.customerId,
        query,
        maxResults: limit,
        pageToken,
        orderBy: 'email',
      }),
    );

    const users = (res.data.users ?? []).map((user) => ({
      primaryEmail: user.primaryEmail ?? '',
      fullName: user.name?.fullName ?? '',
      orgUnitPath: user.orgUnitPath ?? '/',
      suspended: user.suspended === true,
    }));

    return { users, nextPageToken: res.data.nextPageToken ?? undefined };
  }

  /**
   * Generates an initial password. Held in memory only long enough to be
   * encrypted by the credential store; this client never persists it and never
   * logs it (REQ-019).
   */
  generateInitialPassword(length = 24): string {
    // Base64url over random bytes: no ambiguous characters to mis-transcribe
    // when an operator reads it aloud during handover.
    return randomBytes(length).toString('base64url').slice(0, length);
  }

  // --------------------------------------------------------------- groups

  async hasMember(groupKey: string, memberEmail: string): Promise<boolean> {
    try {
      const res = await this.call('members.hasMember', (api) =>
        api.members.hasMember({ groupKey, memberKey: memberEmail }),
      );
      return res.data.isMember === true;
    } catch (err) {
      // A missing group or member is an answer, not a failure.
      if (err instanceof WorkspaceError && err.errorClass === 'not_found') return false;
      throw err;
    }
  }

  async addMember(groupKey: string, memberEmail: string): Promise<void> {
    try {
      await this.call('members.insert', (api) =>
        api.members.insert({ groupKey, requestBody: { email: memberEmail, role: 'MEMBER' } }),
      );
    } catch (err) {
      // Already a member. The intended state holds, which is success.
      if (err instanceof WorkspaceError && err.errorClass === 'conflict') return;
      throw err;
    }
  }

  /** Idempotent: removing a membership that is absent is already satisfied (REQ-005). */
  async removeMember(groupKey: string, memberEmail: string): Promise<{ removed: boolean }> {
    try {
      await this.call('members.delete', (api) => api.members.delete({ groupKey, memberKey: memberEmail }));
      return { removed: true };
    } catch (err) {
      if (err instanceof WorkspaceError && err.errorClass === 'not_found') return { removed: false };
      throw err;
    }
  }

  async listMemberships(memberEmail: string): Promise<string[]> {
    const res = await this.call('groups.list.byMember', (api) =>
      api.groups.list({ customer: this.customerId, userKey: memberEmail, maxResults: 200 }),
    );
    return (res.data.groups ?? []).map((group) => group.email ?? '').filter(Boolean);
  }

  async listGroups(limit = 200): Promise<{ email: string; name: string; description: string }[]> {
    const res = await this.call('groups.list', (api) =>
      api.groups.list({ customer: this.customerId, maxResults: limit }),
    );
    return (res.data.groups ?? []).map((group) => ({
      email: group.email ?? '',
      name: group.name ?? '',
      description: group.description ?? '',
    }));
  }

  // ------------------------------------------------------------ org units

  async listOrgUnits(): Promise<{ orgUnitPath: string; name: string }[]> {
    const res = await this.call('orgunits.list', (api) =>
      api.orgunits.list({ customerId: this.customerId, type: 'all' }),
    );
    return (res.data.organizationUnits ?? []).map((unit) => ({
      orgUnitPath: unit.orgUnitPath ?? '/',
      name: unit.name ?? '',
    }));
  }

  // --------------------------------------------------------------- tokens

  /** Revokes issued OAuth tokens during offboarding (REQ-006). */
  async revokeTokens(primaryEmail: string): Promise<void> {
    const res = await this.call('tokens.list', (api) => api.tokens.list({ userKey: primaryEmail }));
    for (const token of res.data.items ?? []) {
      if (!token.clientId) continue;
      await this.call('tokens.delete', (api) =>
        api.tokens.delete({ userKey: primaryEmail, clientId: token.clientId! }),
      );
    }
  }
}
