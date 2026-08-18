import { config } from './config.js';

/**
 * Accounts that may never be targeted by a lifecycle request (REQ-031).
 *
 * Some Workspace principals are load-bearing for this application. The no-reply
 * account's credential sends every welcome letter and every approval notice; an
 * offboarding request against it would succeed, and onboarding would then fail
 * for everyone with no visible cause, because the letters would simply stop
 * arriving. Break-glass administrator accounts and the Return-Path monitoring
 * group are the same shape of problem.
 *
 * The guard sits at ADMISSION rather than at execution. REQ-001 makes the API
 * the sole creator of requests and steps and the worker only ever executes
 * steps that already exist, so there is no path to a Workspace mutation that
 * gets past this. A second guard in the worker would be duplication rather than
 * defence in depth, and duplication of a rule like this is how the two copies
 * come to disagree.
 *
 * The list is configuration (AC-3). An over-broad entry silently blocks
 * legitimate offboarding, which is why amending it is documented in the runbook
 * rather than left to be discovered.
 */

export class ProtectedAccountError extends Error {
  readonly code = 'protected_account';
  readonly protectedAccount: string;
  readonly attemptedPhase: string;

  constructor(protectedAccount: string, attemptedPhase: string) {
    super(
      `${protectedAccount} is a protected account and cannot be the target of a ${attemptedPhase} request`,
    );
    this.name = 'ProtectedAccountError';
    this.protectedAccount = protectedAccount;
    this.attemptedPhase = attemptedPhase;
  }
}

/**
 * The addresses protected in every deployment, whatever configuration says.
 *
 * The sending identity and the bounce-monitoring group are not a tenant
 * preference: this system cannot notify anyone without them, so a deployment
 * that omitted them from configuration would be one edit away from breaking its
 * own notification path (AC-2). Configured entries add to these, never replace
 * them.
 */
export function defaultProtectedAccounts(
  sender: string | undefined,
  returnPathGroup: string | undefined,
): string[] {
  return [sender, returnPathGroup]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => entry.toLowerCase());
}

export interface ProtectedAccountsOptions {
  /** Configured entries. Defaults to PROTECTED_ACCOUNTS. */
  configured?: readonly string[];
  /** The relay sender, always protected. Defaults to SMTP_SENDER. */
  sender?: string | undefined;
  /** The bounce-monitoring group, always protected. Defaults to RETURN_PATH_GROUP. */
  returnPathGroup?: string | undefined;
}

export class ProtectedAccounts {
  private readonly entries: ReadonlySet<string>;

  constructor(options: ProtectedAccountsOptions = {}) {
    // Key presence, not nullish coalescing. A caller that passes an explicit
    // `sender: undefined` is describing a deployment with no relay wired, and
    // `??` would silently fall back to configuration and load it — which is
    // both wrong and, in a test, a demand for a full environment.
    const configured = 'configured' in options ? (options.configured ?? []) : config.PROTECTED_ACCOUNTS;
    const sender = 'sender' in options ? options.sender : config.SMTP_SENDER;
    const returnPathGroup =
      'returnPathGroup' in options ? options.returnPathGroup : config.RETURN_PATH_GROUP;

    this.entries = new Set(
      [...defaultProtectedAccounts(sender, returnPathGroup), ...configured].map((entry) =>
        entry.toLowerCase(),
      ),
    );
  }

  /** The protected list, for the admin surface and the runbook to render. */
  list(): string[] {
    return [...this.entries].sort();
  }

  /**
   * True when the address is protected.
   *
   * Matching is case-insensitive and covers aliases, because a protected
   * account reachable through ada.l@ when ada.lovelace@ is listed is not
   * protected at all (AC-4). Gmail-style plus tags and dots in the local part
   * both resolve to the same mailbox in Workspace, so both are normalised away
   * before comparing.
   */
  isProtected(address: string): boolean {
    const candidate = address.trim().toLowerCase();
    if (this.entries.has(candidate)) return true;

    const normalised = normalise(candidate);
    for (const entry of this.entries) {
      if (normalise(entry) === normalised) return true;
    }
    return false;
  }

  /**
   * Refuses a targeted request. Throws rather than returning a boolean so a
   * call site cannot forget to act on the answer.
   */
  assertNotProtected(address: string, phase: string): void {
    if (this.isProtected(address)) {
      throw new ProtectedAccountError(address.trim().toLowerCase(), phase);
    }
  }
}

/**
 * Collapses the address forms that reach one Workspace mailbox: a plus tag is
 * dropped and dots in the local part are removed. The domain is left alone,
 * since two domains are two different tenants.
 */
function normalise(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return address;

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const untagged = local.split('+')[0] ?? local;
  return `${untagged.replace(/\./g, '')}@${domain}`;
}
