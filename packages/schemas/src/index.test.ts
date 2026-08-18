import { describe, expect, it } from 'vitest';
import { validatePayload } from './index.js';

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

});

/**
 * REQ-005: the phase 3 payload.
 *
 * The interesting cases are all about the three shapes of "no value". Absent
 * means leave the field alone, null means clear it, and the empty string means
 * neither, so it has to be refused rather than quietly folded into one of them.
 */
describe('the update payload schema', () => {
  const TARGET = { primaryEmail: 'ada.lovelace@company.com' };

  it('accepts an attribute-only update', () => {
    const result = validatePayload('update', { ...TARGET, title: 'Principal Engineer' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.title).toBe('Principal Engineer');
  });

  it('accepts a group-only update', () => {
    const result = validatePayload('update', {
      ...TARGET,
      addGroups: ['platform@company.com'],
      removeGroups: ['research@company.com'],
    });

    expect(result.ok).toBe(true);
  });

  it('accepts null as a request to clear a clearable attribute', () => {
    // Not the same as omitting it. Someone who stops reporting to a manager
    // needs the relation removed, and there is no other way to say so.
    const result = validatePayload('update', {
      ...TARGET,
      managerEmail: null,
      title: null,
      department: null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.managerEmail).toBeNull();
      expect(result.value.title).toBeNull();
    }
  });

  it.each(['title', 'department', 'givenName', 'familyName'])(
    'refuses an empty string for %s',
    (field) => {
      const result = validatePayload('update', { ...TARGET, [field]: '' });

      expect(result.ok).toBe(false);
    },
  );

  it('refuses clearing a name or an org unit, which have no empty state', () => {
    expect(validatePayload('update', { ...TARGET, givenName: null }).ok).toBe(false);
    expect(validatePayload('update', { ...TARGET, orgUnitPath: null }).ok).toBe(false);
  });

  it('refuses an update that changes nothing', () => {
    // It would plan no work, run to 'succeeded', and read as a completed
    // update that never touched the account.
    const result = validatePayload('update', TARGET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.includes('at least one'))).toBe(true);
    }
  });

  it('refuses a group that is both added and removed', () => {
    // The two steps would race and whichever landed last would decide.
    const result = validatePayload('update', {
      ...TARGET,
      addGroups: ['platform@company.com'],
      removeGroups: ['platform@company.com'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe('removeGroups');
  });

  it('deduplicates both group lists', () => {
    const result = validatePayload('update', {
      ...TARGET,
      addGroups: ['platform@company.com', 'platform@company.com'],
      removeGroups: ['research@company.com', 'research@company.com'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.addGroups).toEqual(['platform@company.com']);
      expect(result.value.removeGroups).toEqual(['research@company.com']);
    }
  });

  it('refuses an unrecognised field rather than dropping it', () => {
    expect(validatePayload('update', { ...TARGET, title: 'Lead', jobLevel: 7 }).ok).toBe(false);
  });

  it('refuses an attempt to assign a Workspace admin role (AC-9)', () => {
    // Not a field this phase has, and strict mode is what keeps it from being
    // silently ignored if someone tries.
    for (const field of ['roles', 'adminRole', 'roleAssignments', 'isAdmin']) {
      expect(validatePayload('update', { ...TARGET, [field]: 'super-admin' }).ok).toBe(false);
    }
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

/**
 * REQ-006: the phase 4 payload.
 *
 * Small, because offboarding takes almost no input: who is leaving, optionally
 * who inherits their Drive, and optionally how long to wait before the
 * irreversible step.
 */
describe('the delete payload schema', () => {
  const TARGET = { primaryEmail: 'ada.lovelace@company.com' };

  it('accepts the target alone', () => {
    expect(validatePayload('delete', TARGET).ok).toBe(true);
  });

  it('accepts a Drive successor and a hold period', () => {
    const result = validatePayload('delete', {
      ...TARGET,
      transferDriveTo: 'grace.hopper@company.com',
      holdHours: 48,
      reason: 'left the company on the 14th',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.transferDriveTo).toBe('grace.hopper@company.com');
  });

  it('refuses a successor that is the account being deleted', () => {
    // Workspace would accept it and it would achieve nothing, leaving an
    // operator believing the files were saved.
    const result = validatePayload('delete', {
      ...TARGET,
      transferDriveTo: TARGET.primaryEmail,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe('transferDriveTo');
  });

  it.each([0, -1, 721, 1.5])('refuses a hold period of %s hours', (holdHours) => {
    // A hold is a pause, not an archive. A request parked for a year is a stuck
    // job by any other name.
    expect(validatePayload('delete', { ...TARGET, holdHours }).ok).toBe(false);
  });

  it('refuses an unrecognised field rather than dropping it', () => {
    expect(validatePayload('delete', { ...TARGET, deleteImmediately: true }).ok).toBe(false);
  });

  it('refuses a malformed target', () => {
    expect(validatePayload('delete', { primaryEmail: 'not-an-email' }).ok).toBe(false);
    expect(validatePayload('delete', {}).ok).toBe(false);
  });
});
