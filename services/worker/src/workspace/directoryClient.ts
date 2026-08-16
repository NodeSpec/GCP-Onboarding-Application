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
 * Serves REQ-008 and REQ-013.
 */

/** Least privilege scopes. Every scope here has a named consumer. */
export const DIRECTORY_SCOPES = [
  // Phases 1, 3 and 4 create, read, update and delete users; lookup searches them.
  'https://www.googleapis.com/auth/admin.directory.user',
  // Phases 1, 3 and 4 add and remove memberships; lookup reads them.
  'https://www.googleapis.com/auth/admin.directory.group.member',
  // The group picker enumerates domain groups.
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  // The org unit picker enumerates paths, and phase 1 validates orgUnitPath.
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

/**
 * Raised on 403. Named separately because it almost always means the custom
 * admin role is missing a privilege rather than that the request was bad, and
 * an operator reading the step error needs to be told that directly.
 */
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
  if (status === undefined) return 'retryable'; // network fault, worth another attempt
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'retryable';
  if (status >= 500) return 'retryable';
  return 'terminal'; // 400 and the rest: retrying cannot help
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 20_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full jitter. Removes the synchronised retry storm when many steps fail at once. */
function backoffMs(attempt: number, policy: RetryPolicy): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.random() * ceiling;
}

export class DirectoryClient {
  private readonly auth: GoogleAuth;
  private readonly retry: RetryPolicy;
  private api: admin_directory_v1.Admin | undefined;

  constructor(retry: RetryPolicy = DEFAULT_RETRY) {
    // Application Default Credentials from the Cloud Run metadata server.
    // No keyFile, no credentials object, no subject.
    this.auth = new GoogleAuth({ scopes: [...DIRECTORY_SCOPES] });
    this.retry = retry;
  }

  private async client(): Promise<admin_directory_v1.Admin> {
    if (!this.api) {
      this.api = google.admin({ version: 'directory_v1', auth: this.auth });
    }
    return this.api;
  }

  /**
   * Every Directory call goes through here. Callers describe the operation and
   * receive typed failures; they never see a raw googleapis error and never
   * decide for themselves whether something is worth retrying.
   */
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

        const isLastAttempt = attempt === this.retry.maxAttempts - 1;
        if (isLastAttempt) break;

        const honoured = retryAfterSeconds(err);
        const delay = honoured !== undefined ? honoured * 1000 : backoffMs(attempt, this.retry);
        logger.warn(
          { operation, status, attempt: attempt + 1, delayMs: Math.round(delay) },
          'retrying Workspace call',
        );
        await sleep(delay);
      }
    }

    const status = statusOf(lastError);
    throw new WorkspaceError(
      `Workspace ${operation} exhausted ${this.retry.maxAttempts} attempts`,
      'retryable',
      status,
      operation,
      { cause: lastError },
    );
  }

  /** Returns null on 404 rather than throwing, so callers can express "is this already true?". */
  async getUser(primaryEmail: string): Promise<admin_directory_v1.Schema$User | null> {
    try {
      const res = await this.call('users.get', (api) => api.users.get({ userKey: primaryEmail }));
      return res.data;
    } catch (err) {
      if (err instanceof WorkspaceError && err.errorClass === 'not_found') return null;
      throw err;
    }
  }
}
