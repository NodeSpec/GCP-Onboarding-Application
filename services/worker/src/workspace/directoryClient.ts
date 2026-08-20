import { randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { google, type admin_datatransfer_v1, type admin_directory_v1 } from 'googleapis';
import { logger } from '../logging.js';

export const DIRECTORY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.group.member',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
  'https://www.googleapis.com/auth/admin.datatransfer',
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

export class UserAlreadyExistsError extends WorkspaceError {
  constructor(
    readonly primaryEmail: string,
    operation: string,
    options?: { cause?: unknown },
  ) {
    super(
      `A user already exists with primary email ${primaryEmail}`,
      'conflict',
      409,
      operation,
      options,
    );
    this.name = 'UserAlreadyExistsError';
  }
}

export class UserNotFoundError extends WorkspaceError {
  constructor(
    readonly primaryEmail: string,
    operation: string,
    options?: { cause?: unknown },
  ) {
    super(
      `No user exists with primary email ${primaryEmail}`,
      'not_found',
      404,
      operation,
      options,
    );
    this.name = 'UserNotFoundError';
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

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoffMs(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return random() * ceiling;
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

export interface DirectoryClientOptions {
  customerId: string;
  retry?: RetryPolicy;
  api?: admin_directory_v1.Admin;
  transferApi?: admin_datatransfer_v1.Admin;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class DirectoryClient {
  private readonly auth: GoogleAuth | undefined;
  private readonly retry: RetryPolicy;
  private readonly customerId: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private api: admin_directory_v1.Admin | undefined;
  private transferApi: admin_datatransfer_v1.Admin | undefined;

  constructor(options: DirectoryClientOptions) {
    this.auth =
      options.api && options.transferApi ? undefined : new GoogleAuth({ scopes: [...DIRECTORY_SCOPES] });
    this.api = options.api;
    this.transferApi = options.transferApi;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.customerId = options.customerId;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
  }

  private async client(): Promise<admin_directory_v1.Admin> {
    if (!this.api) {
      if (!this.auth) throw new Error('DirectoryClient has neither an injected api nor credentials');
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
        const delay =
          honoured !== undefined ? honoured * 1000 : backoffMs(attempt, this.retry, this.random);
        logger.warn(
          { operation, status, attempt: attempt + 1, delayMs: Math.round(delay) },
          'retrying Workspace call',
        );
        await this.sleep(delay);
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

  async patchUser(
    primaryEmail: string,
    patch: admin_directory_v1.Schema$User,
  ): Promise<admin_directory_v1.Schema$User> {
    const res = await this.call('users.patch', (api) =>
      api.users.patch({ userKey: primaryEmail, requestBody: patch }),
    );
    return res.data;
  }

  async resetPassword(primaryEmail: string, password: string): Promise<void> {
    await this.call('users.update.password', (api) =>
      api.users.update({
        userKey: primaryEmail,
        requestBody: { password, changePasswordAtNextLogin: true },
      }),
    );
  }

  async setSuspended(primaryEmail: string, suspended: boolean): Promise<void> {
    await this.call('users.update.suspended', (api) =>
      api.users.update({ userKey: primaryEmail, requestBody: { suspended } }),
    );
  }

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

  async searchUsers(query: string, limit = 25, pageToken?: string): Promise<{ users: UserSummary[]; nextPageToken?: string }> {
    const res = await this.call('users.list', (api) =>
      api.users.list({
        customer: this.customerId,
        query,
        maxResults: limit,
        ...(pageToken === undefined ? {} : { pageToken }),
        orderBy: 'email',
      }),
    );

    const users = (res.data.users ?? []).map((user) => ({
      primaryEmail: user.primaryEmail ?? '',
      fullName: user.name?.fullName ?? '',
      orgUnitPath: user.orgUnitPath ?? '/',
      suspended: user.suspended === true,
    }));

    const nextPageToken = res.data.nextPageToken ?? undefined;
    return { users, ...(nextPageToken === undefined ? {} : { nextPageToken }) };
  }

  generateInitialPassword(length = 24): string {
    return randomBytes(length).toString('base64url').slice(0, length);
  }

  async hasMember(groupKey: string, memberEmail: string): Promise<boolean> {
    try {
      const res = await this.call('members.hasMember', (api) =>
        api.members.hasMember({ groupKey, memberKey: memberEmail }),
      );
      return res.data.isMember === true;
    } catch (err) {
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
      if (err instanceof WorkspaceError && err.errorClass === 'conflict') return;
      throw err;
    }
  }

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
    // userKey ALONE. Third reading of this call, and unlike the first two it
    // is backed by a live failure on each side rather than a theory:
    //
    // - customer + userKey together is refused outright. The API treats the
    //   two as mutually exclusive scopes and answers a bare 400 Bad Request,
    //   with the real customer id exactly as with the `my_customer` alias.
    //   That shape shipped once and broke every sign-in, because role
    //   resolution walks through here.
    // - userKey alone is the documented shape, but a service account acting
    //   as itself has been seen to get 404 "Domain not found" from it: the
    //   caller's own domain is *.iam.gserviceaccount.com, and when the API
    //   tries to infer a tenant from the caller it finds nothing. Handled
    //   below rather than allowed to escape.
    //
    // On that 404 the sweep falls back to asking every group in the tenant
    // directly through members.hasMember, which is known to work under this
    // identity because the create phase depends on it. One call per group and
    // deliberately sequential, so a large tenant leans on the queue's rate
    // budget instead of bursting the Directory quota; the path only runs when
    // the direct listing is refused, and the API service caches the result.
    try {
      const res = await this.call('groups.list.byMember', (api) =>
        api.groups.list({ userKey: memberEmail, maxResults: 200 }),
      );
      return (res.data.groups ?? []).map((group) => group.email ?? '').filter(Boolean);
    } catch (err) {
      if (!(err instanceof WorkspaceError) || err.errorClass !== 'not_found') throw err;

      logger.warn(
        { operation: 'groups.list.byMember' },
        'byMember listing refused with 404; falling back to per-group membership checks',
      );

      const memberships: string[] = [];
      for (const group of await this.listGroups(200)) {
        if (await this.hasMember(group.email, memberEmail)) memberships.push(group.email);
      }
      return memberships;
    }
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

  async listOrgUnits(): Promise<{ orgUnitPath: string; name: string }[]> {
    const res = await this.call('orgunits.list', (api) =>
      api.orgunits.list({ customerId: this.customerId, type: 'all' }),
    );
    return (res.data.organizationUnits ?? []).map((unit) => ({
      orgUnitPath: unit.orgUnitPath ?? '/',
      name: unit.name ?? '',
    }));
  }

  private async transferClient(): Promise<admin_datatransfer_v1.Admin> {
    if (!this.transferApi) {
      if (!this.auth) {
        throw new Error('DirectoryClient has neither an injected transfer api nor credentials');
      }
      this.transferApi = google.admin({ version: 'datatransfer_v1', auth: this.auth });
    }
    return this.transferApi;
  }

  async driveApplicationId(): Promise<string> {
    const api = await this.transferClient();
    const res = await this.call('datatransfer.applications.list', () =>
      api.applications.list({ customerId: this.customerId }),
    );

    const drive = (res.data.applications ?? []).find((app) =>
      (app.name ?? '').toLowerCase().includes('drive'),
    );
    if (!drive?.id) {
      throw new WorkspaceError(
        'No Drive and Docs application is available for data transfer in this tenant',
        'terminal',
        404,
        'datatransfer.applications.list',
      );
    }
    return drive.id;
  }

  async findDriveTransfer(
    oldOwnerUserId: string,
  ): Promise<{ id: string; status: string } | null> {
    const api = await this.transferClient();
    const res = await this.call('datatransfer.transfers.list', () =>
      api.transfers.list({ customerId: this.customerId, oldOwnerUserId, maxResults: 10 }),
    );

    const transfers = res.data.dataTransfers ?? [];
    const latest = transfers[0];
    if (!latest?.id) return null;
    return { id: latest.id, status: latest.overallTransferStatusCode ?? 'unknown' };
  }

  async startDriveTransfer(params: {
    oldOwnerUserId: string;
    newOwnerUserId: string;
    applicationId: string;
  }): Promise<{ id: string; status: string }> {
    const api = await this.transferClient();
    const res = await this.call('datatransfer.transfers.insert', () =>
      api.transfers.insert({
        requestBody: {
          oldOwnerUserId: params.oldOwnerUserId,
          newOwnerUserId: params.newOwnerUserId,
          applicationDataTransfers: [
            {
              applicationId: params.applicationId,
              applicationTransferParams: [{ key: 'PRIVACY_LEVEL', value: ['PRIVATE', 'SHARED'] }],
            },
          ],
        },
      }),
    );

    if (!res.data.id) {
      throw new WorkspaceError(
        'Workspace accepted the transfer but returned no id',
        'retryable',
        undefined,
        'datatransfer.transfers.insert',
      );
    }
    return { id: res.data.id, status: res.data.overallTransferStatusCode ?? 'inProgress' };
  }

  async driveTransferStatus(transferId: string): Promise<string> {
    const api = await this.transferClient();
    const res = await this.call('datatransfer.transfers.get', () =>
      api.transfers.get({ dataTransferId: transferId }),
    );
    return res.data.overallTransferStatusCode ?? 'unknown';
  }

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
