import { describe, expect, it } from 'vitest';
import { validatePayload } from './schemas.js';

/**
 * TC-REQ-001-4: the payload is validated before anything is persisted.
 *
 * These assert the schema's decisions only. That validation runs BEFORE the
 * write is a property of the route's ordering and is asserted in the emulator
 * suite, where a rejected submission can be shown to have left no documents.
 */

const VALID = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  orgUnitPath: '/Engineering',
  groups: ['engineering@company.com'],
};

describe('the create payload schema', () => {
  it('accepts a well-formed payload', () => {
    const result = validatePayload('create', VALID);
    expect(result.ok).toBe(true);
  });

  it('accepts a payload carrying only the required fields', () => {
    const result = validatePayload('create', {
      primaryEmail: 'a@company.com',
      givenName: 'A',
      familyName: 'B',
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a missing primary email', { givenName: 'A', familyName: 'B' }],
    ['a malformed primary email', { ...VALID, primaryEmail: 'not-an-email' }],
    ['an empty given name', { ...VALID, givenName: '   ' }],
    ['a malformed manager email', { ...VALID, managerEmail: 'nope' }],
    ['a malformed group address', { ...VALID, groups: ['not-an-email'] }],
    ['an org unit path with no leading slash', { ...VALID, orgUnitPath: 'Engineering' }],
    ['an org unit path containing whitespace', { ...VALID, orgUnitPath: '/Eng Team' }],
  ])('refuses %s', (_label, payload) => {
    const result = validatePayload('create', payload);
    expect(result.ok).toBe(false);
  });

  it('refuses an unrecognised field rather than dropping it', () => {
    // A typo in an attribute name should fail at submission, not quietly
    // produce an account missing the attribute the operator thought they set.
    const result = validatePayload('create', { ...VALID, departmnet: 'Platform' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.issues)).toContain('departmnet');
    }
  });

  it('names the offending field in every issue it reports', () => {
    const result = validatePayload('create', { ...VALID, primaryEmail: 'bad', givenName: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.path).sort()).toEqual(['givenName', 'primaryEmail']);
    }
  });

  it('normalises email casing so identity cannot fork on it', () => {
    const result = validatePayload('create', { ...VALID, primaryEmail: 'Ada.Lovelace@Company.com' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.primaryEmail).toBe('ada.lovelace@company.com');
  });

  it('deduplicates groups, so one membership cannot become two racing steps', () => {
    const result = validatePayload('create', {
      ...VALID,
      groups: ['eng@company.com', 'eng@company.com', 'platform@company.com'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.groups).toEqual(['eng@company.com', 'platform@company.com']);
  });

  it('trims surrounding whitespace rather than persisting it', () => {
    const result = validatePayload('create', { ...VALID, givenName: '  Ada  ' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.givenName).toBe('Ada');
  });

  it.each(['update', 'delete'] as const)('refuses the unimplemented %s phase', (phase) => {
    const result = validatePayload(phase, VALID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.message).toContain('not implemented');
  });
});

describe('the notify payload schema (REQ-004)', () => {
  const NOTIFY = {
    primaryEmail: 'ada.lovelace@company.com',
    givenName: 'Ada',
    familyName: 'Lovelace',
    notificationEmail: 'ada.personal@example.com',
  };

  it('admits a notify payload with an out-of-band address', () => {
    expect(validatePayload('notify', NOTIFY).ok).toBe(true);
  });

  it('requires a notification address, since the letter needs somewhere to go', () => {
    const { notificationEmail, ...withoutAddress } = NOTIFY;
    void notificationEmail;

    expect(validatePayload('notify', withoutAddress).ok).toBe(false);
  });

  it('refuses the new primary mailbox as the notification address', () => {
    // A guaranteed dead end rather than an edge case: the mailbox cannot be
    // read until the first sign-in that the letter is explaining (AC-2).
    const result = validatePayload('notify', {
      ...NOTIFY,
      notificationEmail: NOTIFY.primaryEmail,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe('notificationEmail');
  });

  it('refuses an unrecognised field rather than dropping it', () => {
    expect(validatePayload('notify', { ...NOTIFY, regenrate: true }).ok).toBe(false);
  });
});

describe('the resend flag on the notify payload (REQ-030)', () => {
  const NOTIFY = {
    primaryEmail: 'ada.lovelace@company.com',
    givenName: 'Ada',
    familyName: 'Lovelace',
    notificationEmail: 'ada.personal@example.com',
  };

  it('defaults regenerate to false when the operator does not mention it', () => {
    // The default is the whole point. Resetting a real person's password has to
    // be something an operator asked for, never a fallback the system reaches
    // for because a stored credential turned out to be unusable (AC-4).
    const result = validatePayload('notify', NOTIFY);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.regenerate).toBe(false);
  });

  it('accepts an explicit regeneration request', () => {
    const result = validatePayload('notify', { ...NOTIFY, regenerate: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.regenerate).toBe(true);
  });

  it('refuses a truthy non-boolean rather than coercing it', () => {
    // 'false' as a string is truthy in JavaScript. Coercing here is how a
    // console bug that sends strings would start resetting passwords nobody
    // asked to reset.
    for (const regenerate of ['true', 'false', 1, 0, 'yes']) {
      expect(validatePayload('notify', { ...NOTIFY, regenerate }).ok).toBe(false);
    }
  });
});
