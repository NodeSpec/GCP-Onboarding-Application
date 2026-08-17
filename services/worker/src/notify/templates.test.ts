import { describe, expect, it } from 'vitest';
import {
  APPROVER_TEMPLATE_VERSION,
  WELCOME_TEMPLATE_VERSION,
  consoleLinkFor,
  renderApproverNotice,
  renderWelcome,
} from './templates.js';

/**
 * TC-REQ-004-1, TC-REQ-004-4 and TC-REQ-032-5: what the messages say, and more
 * importantly what they must never say.
 *
 * Both templates are rendered here with a FULLY populated context, including a
 * password and a computed diff neither is supposed to use. That is the whole
 * design of these tests: a template that quietly started interpolating a
 * credential would pass any test that simply never supplied one.
 */

const SECRET = 'Tr0ub4dor-and-3-horses';

const WELCOME = {
  givenName: 'Ada',
  familyName: 'Lovelace',
  primaryEmail: 'ada.lovelace@company.com',
  // Deliberately supplied. Must not appear.
  oneTimePassword: SECRET,
};

const APPROVER = {
  requestId: 'req-42',
  phase: 'delete',
  targetUser: 'grace.hopper@company.com',
  requestedBy: 'operator@company.com',
  deadline: '2026-09-01T12:00:00.000Z',
  consoleUrl: 'https://console.company.com/requests/req-42',
  // Deliberately supplied. Must not appear.
  computedDiff: { department: { from: 'Research', to: 'Engineering' }, salary: 120000 },
  oneTimePassword: SECRET,
};

describe('AC-1: the welcome letter carries the details the new person needs', () => {
  it('substitutes the name and the primary address', () => {
    const message = renderWelcome(WELCOME);

    expect(message.body).toContain('Ada Lovelace');
    expect(message.body).toContain('ada.lovelace@company.com');
    expect(message.subject).toBe('Your new work account');
  });

  it('explains that the password is set at first sign-in', () => {
    const message = renderWelcome(WELCOME);

    expect(message.body.toLowerCase()).toContain('set your own password');
    expect(message.body).toContain('https://accounts.google.com/');
  });

  it('carries the template version so an old audit entry can be read back', () => {
    expect(renderWelcome(WELCOME).version).toBe(WELCOME_TEMPLATE_VERSION);
  });

  it('leaves the recipient to the caller rather than guessing it', () => {
    // The address is decided from the request payload, never from the template.
    expect(renderWelcome(WELCOME).to).toEqual([]);
  });
});

describe('AC-4: the welcome letter grants no access', () => {
  it('contains no password even when one is in the context', () => {
    const body = renderWelcome(WELCOME).body;

    expect(body).not.toContain(SECRET);
    expect(body.toLowerCase()).not.toMatch(/temporary password is|password:/);
  });

  it('contains no link into this application', () => {
    const body = renderWelcome(WELCOME).body;

    // The only URL is Google's sign-in page. A claim link or a password-setting
    // page here would be an unauthenticated route into the system, which is
    // exactly what keeping everything behind IAP forbids (REQ-007).
    const urls = body.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual(['https://accounts.google.com/']);
  });

  it('says plainly that the password comes by another channel', () => {
    // Not decoration: without it the recipient waits for a credential the
    // letter was never going to carry.
    expect(renderWelcome(WELCOME).body).toContain('not included in this message');
  });
});

describe('AC-5 (REQ-032): the approver notice says what is needed and nothing more', () => {
  it('carries the request, phase, target, requester and deadline', () => {
    const body = renderApproverNotice(APPROVER).body;

    expect(body).toContain('req-42');
    expect(body).toContain('delete');
    expect(body).toContain('grace.hopper@company.com');
    expect(body).toContain('operator@company.com');
    expect(body).toContain('2026-09-01T12:00:00.000Z');
  });

  it('omits the deadline line entirely when no expiry is configured', () => {
    const { deadline, ...withoutDeadline } = APPROVER;
    void deadline;

    expect(renderApproverNotice(withoutDeadline).body).not.toContain('Decide by');
  });

  it('links to the console', () => {
    expect(renderApproverNotice(APPROVER).body).toContain(
      'https://console.company.com/requests/req-42',
    );
  });

  it('contains no computed diff and no attribute values', () => {
    const body = renderApproverNotice(APPROVER).body;

    // Mail is forwarded, archived and searched by people who were never
    // entitled to the detail. The console shows it to an authenticated approver.
    expect(body).not.toContain('Research');
    expect(body).not.toContain('Engineering');
    expect(body).not.toContain('120000');
    expect(body).not.toContain('computedDiff');
  });

  it('contains no credential or token', () => {
    expect(renderApproverNotice(APPROVER).body).not.toContain(SECRET);
  });

  it('names the phase and target in the subject, so an inbox is scannable', () => {
    expect(renderApproverNotice(APPROVER).subject).toBe(
      'Approval needed: delete for grace.hopper@company.com',
    );
  });

  it('carries the template version', () => {
    expect(renderApproverNotice(APPROVER).version).toBe(APPROVER_TEMPLATE_VERSION);
  });
});

describe('AC-6 (REQ-032): the console link points at the IAP-protected console', () => {
  it('builds a request deep link from the configured base', () => {
    expect(consoleLinkFor('https://console.company.com', 'req-42')).toBe(
      'https://console.company.com/requests/req-42',
    );
  });

  it('tolerates a trailing slash on the base without doubling it', () => {
    expect(consoleLinkFor('https://console.company.com/', 'req-42')).toBe(
      'https://console.company.com/requests/req-42',
    );
  });

  it('encodes the request id rather than trusting it into the path', () => {
    expect(consoleLinkFor('https://console.company.com', 'a/../b')).toBe(
      'https://console.company.com/requests/a%2F..%2Fb',
    );
  });
});
