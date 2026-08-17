import type { Message } from './sender.js';

/**
 * The message templates, versioned and pure.
 *
 * Pure on purpose: a template that reaches for data itself could pick up a
 * credential nobody meant to include. These take a context, substitute, and
 * return, which is what lets a test render with a FULLY populated context —
 * password and all — and assert none of it appears in the output
 * (REQ-004 AC-4, REQ-032 AC-5).
 *
 * The version travels with the record so an operator reading an old audit entry
 * knows which wording went out.
 */

export const WELCOME_TEMPLATE_VERSION = 'welcome-v1';
export const APPROVER_TEMPLATE_VERSION = 'approver-v1';

export interface WelcomeContext {
  givenName: string;
  familyName: string;
  primaryEmail: string;
  /**
   * Present so the test can prove it is NOT used. The letter carries no
   * credential: the account is created with changePasswordAtNextLogin=true and
   * Google's own first-sign-in flow sets the password, which is what keeps this
   * application free of any unauthenticated route (REQ-004, REQ-007).
   */
  oneTimePassword?: string;
  signInUrl?: string;
}

export interface ApproverContext {
  requestId: string;
  phase: string;
  targetUser: string;
  requestedBy: string;
  /** Absent when the policy configures no expiry. */
  deadline?: string;
  consoleUrl: string;
  /** Present so the test can prove none of it is included (REQ-032 AC-5). */
  computedDiff?: Record<string, unknown>;
  oneTimePassword?: string;
}

const SIGN_IN_URL = 'https://accounts.google.com/';

/**
 * The welcome letter.
 *
 * Note what is absent: no password, no token, no claim link, nothing that
 * grants access. The only URL is Google's own sign-in page, which is not a
 * credential and not a route into this application. A person being onboarded is
 * not an IAP principal and never touches this system.
 */
export function renderWelcome(ctx: WelcomeContext): Message & { version: string } {
  const body = [
    `Hello ${ctx.givenName} ${ctx.familyName},`,
    '',
    'Your work account has been created:',
    '',
    `    ${ctx.primaryEmail}`,
    '',
    'To finish setting up, sign in at the address below. You will be asked to',
    'set your own password the first time you sign in.',
    '',
    `    ${ctx.signInUrl ?? SIGN_IN_URL}`,
    '',
    'Your IT administrator will give you your temporary password separately.',
    'It is deliberately not included in this message.',
    '',
    'If you were not expecting this, please contact your IT administrator.',
  ].join('\n');

  return {
    to: [],
    subject: 'Your new work account',
    body,
    version: WELCOME_TEMPLATE_VERSION,
  };
}

/**
 * The approver notice.
 *
 * Deliberately thin: enough to know a decision is wanted and which request it
 * concerns, and a link. No computed diff and no attribute values, because the
 * approver clicking through is authenticated at the perimeter and the console
 * shows them everything. Mail is the worst place to put change detail: it is
 * forwarded, archived and searched by people who were never entitled to it.
 */
export function renderApproverNotice(ctx: ApproverContext): Message & { version: string } {
  const lines = [
    'A lifecycle request is waiting for your approval.',
    '',
    `    Request:  ${ctx.requestId}`,
    `    Phase:    ${ctx.phase}`,
    `    Account:  ${ctx.targetUser}`,
    `    Raised by: ${ctx.requestedBy}`,
  ];

  if (ctx.deadline) lines.push(`    Decide by: ${ctx.deadline}`);

  lines.push(
    '',
    'Review the request and approve or reject it here:',
    '',
    `    ${ctx.consoleUrl}`,
    '',
    'You will be asked to sign in. The console shows the full detail of the',
    'change; it is not repeated in this message.',
  );

  return {
    to: [],
    subject: `Approval needed: ${ctx.phase} for ${ctx.targetUser}`,
    body: lines.join('\n'),
    version: APPROVER_TEMPLATE_VERSION,
  };
}

/** The console deep link for a request. Behind IAP, like every other route. */
export function consoleLinkFor(consoleBaseUrl: string, requestId: string): string {
  return `${consoleBaseUrl.replace(/\/+$/, '')}/requests/${encodeURIComponent(requestId)}`;
}
