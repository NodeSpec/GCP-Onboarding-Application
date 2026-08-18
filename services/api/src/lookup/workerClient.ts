import { config } from '../config.js';

/**
 * The API service's client for the worker's read-only lookup surface (REQ-029).
 *
 * The API holds no Workspace credential and never will — that separation is
 * REQ-008 AC-7 and REQ-014, and it is enforced by a repository scan that fails
 * if this service so much as names the Directory client. So the console's
 * pickers are served by proxying to the worker, which holds the only admin
 * role, and this module is the one place that call is made.
 *
 * The identity token comes from the instance metadata server rather than from
 * an auth library helper. Two reasons, and both are constraints rather than
 * preferences: the customer prohibits service-account key files, so the token
 * must come from the runtime identity (REQ-008 AC-2); and the identity-hygiene
 * scan forbids this service from constructing a Google auth client at all, so
 * the token is fetched over plain HTTP from the address only a GCP runtime can
 * reach. Nothing is signed here and no credential is held.
 */

/**
 * The metadata endpoint that mints an identity token for the runtime identity.
 *
 * The path segment is service-accountS, plural. Singular reads perfectly
 * naturally and is wrong: the metadata server answers 404 for it, which this
 * client reports as LookupUnavailable, which fails every role resolution that
 * consults group membership. No test catches a mistake here, because every
 * suite injects a fake token source and this constant is only read where a real
 * metadata server exists, which is to say in a deployed GCP runtime.
 */
const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

/** How long before expiry a cached token is considered spent. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface TokenSource {
  (audience: string): Promise<string>;
}

/**
 * Reads an identity token for the given audience from the metadata server.
 * The audience is the worker's base URL, which is what the worker verifies the
 * token against.
 */
export const metadataIdentityToken: TokenSource = async (audience) => {
  const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full`;
  const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });

  if (!res.ok) {
    throw new Error(`metadata server returned ${res.status} for an identity token`);
  }
  return (await res.text()).trim();
};

/** Decodes the exp claim without verifying: this token is ours, not a caller's. */
function expiryOf(token: string): number {
  const segment = token.split('.')[1];
  if (!segment) return 0;
  try {
    const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  } catch {
    // An undecodable token is treated as already expired, so the next call
    // fetches a fresh one rather than sending something unusable.
    return 0;
  }
}

export interface WorkerLookupOptions {
  baseUrl?: string;
  tokenSource?: TokenSource;
  /** Injectable so a test does not have to stand on the real clock. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export class LookupUnavailable extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'LookupUnavailable';
    this.status = status;
  }
}

/**
 * Calls the worker's /lookup routes on behalf of the console.
 *
 * The token is cached until shortly before it expires. Minting one per keystroke
 * of a search box would put a metadata round trip in front of every character
 * an operator types.
 */
export class WorkerLookupClient {
  private readonly baseUrl: string;
  private readonly tokenSource: TokenSource;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(options: WorkerLookupOptions = {}) {
    this.baseUrl = (options.baseUrl ?? config.WORKER_BASE_URL).replace(/\/+$/, '');
    this.tokenSource = options.tokenSource ?? metadataIdentityToken;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async token(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > now) {
      return this.cached.token;
    }

    const token = await this.tokenSource(this.baseUrl);
    this.cached = { token, expiresAt: expiryOf(token) };
    return token;
  }

  /**
   * Issues one GET against the worker and returns its parsed body.
   *
   * The worker's status is passed through rather than flattened: a 404 for a
   * user who does not exist and a 403 for a missing admin role are different
   * things for the console to say, and collapsing both to 502 would make the
   * picker unable to tell "no such user" from "lookup is broken".
   */
  async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/lookup${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${await this.token()}` },
      });
    } catch (err) {
      throw new LookupUnavailable(
        `directory lookup could not be reached: ${err instanceof Error ? err.message : 'unknown'}`,
        502,
      );
    }

    if (!res.ok) {
      throw new LookupUnavailable(`directory lookup returned ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }
}
