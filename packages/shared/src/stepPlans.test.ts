import { describe, expect, it } from 'vitest';
import {
  COMPENSATING_STEP,
  InvalidPhasePayload,
  deriveIdempotencyKey,
  stepPlanFor,
} from './stepPlans.js';

/**
 * TC-REQ-013-2 and the plan half of TC-REQ-001-3.
 *
 * The idempotency key is the mechanism three separate guarantees rest on:
 * Cloud Tasks deduplication, the executor's transactional claim, and a
 * handler recognising its own earlier attempt. All three fail quietly if the
 * key varies across attempts, so that property is tested directly rather than
 * inferred from the code.
 */

const PAYLOAD = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  groups: ['engineering@company.com', 'platform@company.com'],
};

describe('the create step plan', () => {
  it('orders validation, creation, attributes, groups, then verification', () => {
    expect(stepPlanFor('create', PAYLOAD).map((s) => s.name)).toEqual([
      'validate-request',
      'create-user',
      'apply-attributes',
      'assign-group',
      'assign-group',
      'verify-account',
    ]);
  });

  it('emits one group step per group, each carrying its own group key', () => {
    const groupSteps = stepPlanFor('create', PAYLOAD).filter((s) => s.name === 'assign-group');

    expect(groupSteps.map((s) => s.input.groupKey)).toEqual(PAYLOAD.groups);
  });

  it('emits no group step when the request asks for no groups', () => {
    const { groups: _omitted, ...noGroups } = PAYLOAD;
    const plan = stepPlanFor('create', noGroups);

    expect(plan.filter((s) => s.name === 'assign-group')).toHaveLength(0);
    expect(plan).toHaveLength(4);
  });

  it('is pure: the same payload always yields the same plan', () => {
    expect(stepPlanFor('create', PAYLOAD)).toEqual(stepPlanFor('create', PAYLOAD));
  });

  it('refuses a groups field that is not an array of non-empty strings', () => {
    for (const groups of ['engineering@company.com', [''], [42], [null]]) {
      expect(() => stepPlanFor('create', { ...PAYLOAD, groups })).toThrow(InvalidPhasePayload);
    }
  });

  it('plans the notify phase as validate, settle the credential, then send', () => {
    // Sending is ONE step: splitting render from deliver would create a step
    // that can succeed while the person still hears nothing (REQ-004).
    expect(stepPlanFor('notify', PAYLOAD).map((s) => s.name)).toEqual([
      'validate-notify-request',
      'confirm-credential',
      'send-welcome-letter',
    ]);
  });

  it('swaps in the regeneration step when the operator asked for a new password', () => {
    // Two names rather than one step that branches internally, because approval
    // policy is keyed by step name. A tenant that wants a second pair of eyes on
    // a password reset must be able to require it WITHOUT putting an approval in
    // front of every ordinary resend (REQ-030 AC-7).
    expect(stepPlanFor('notify', { ...PAYLOAD, regenerate: true }).map((s) => s.name)).toEqual([
      'validate-notify-request',
      'regenerate-credential',
      'send-welcome-letter',
    ]);
  });

  it('treats a missing or false regenerate flag as no regeneration', () => {
    // Only an explicit true regenerates. Anything else resetting a real
    // person's password would be the worst kind of default.
    for (const regenerate of [undefined, false, 'true', 1, null]) {
      const plan = stepPlanFor('notify', { ...PAYLOAD, regenerate }).map((s) => s.name);
      expect(plan).toContain('confirm-credential');
      expect(plan).not.toContain('regenerate-credential');
    }
  });

  it('validates before it touches the credential, on both notify plans', () => {
    // AC-9 rests on this ordering: a resend for a deleted account has to fail in
    // validation, before any step resets a password or sends anything.
    for (const regenerate of [false, true]) {
      const plan = stepPlanFor('notify', { ...PAYLOAD, regenerate }).map((s) => s.name);
      expect(plan[0]).toBe('validate-notify-request');
      expect(plan[plan.length - 1]).toBe('send-welcome-letter');
    }
  });
});

describe('AC-2: the idempotency key is stable across attempts and distinct across steps', () => {
  it('is identical for repeated derivations of the same step', () => {
    const first = deriveIdempotencyKey('req-1', 'step-2', { groupKey: 'a@company.com' });
    const second = deriveIdempotencyKey('req-1', 'step-2', { groupKey: 'a@company.com' });

    expect(first).toBe(second);
  });

  it('does not vary with attempt number, because nothing about the attempt is in it', () => {
    // The signature has no attempt parameter at all. This asserts the property
    // the signature is meant to guarantee: a retry re-derives the same key from
    // the same persisted step, which is what Cloud Tasks deduplicates on.
    const step = { requestId: 'req-1', stepId: 'step-2', input: { groupKey: 'a@company.com' } };
    const keys = [1, 2, 3, 4, 5].map(() =>
      deriveIdempotencyKey(step.requestId, step.stepId, step.input),
    );

    expect(new Set(keys).size).toBe(1);
  });

  it('is distinct across steps of the same request, even with identical input', () => {
    // The common case: three of the five create steps carry an empty input.
    const plan = stepPlanFor('create', PAYLOAD);
    const keys = plan.map((entry, index) => deriveIdempotencyKey('req-1', `step-${index}`, entry.input));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is distinct across requests for the same step', () => {
    const a = deriveIdempotencyKey('req-1', 'step-2', {});
    const b = deriveIdempotencyKey('req-2', 'step-2', {});

    expect(a).not.toBe(b);
  });

  it('is distinct when the same step name carries a different group', () => {
    const a = deriveIdempotencyKey('req-1', 'step-3', { groupKey: 'engineering@company.com' });
    const b = deriveIdempotencyKey('req-1', 'step-3', { groupKey: 'platform@company.com' });

    expect(a).not.toBe(b);
  });

  it('does not vary with the key order of an input', () => {
    const a = deriveIdempotencyKey('req-1', 'step-1', { alpha: 1, beta: 2 });
    const b = deriveIdempotencyKey('req-1', 'step-1', { beta: 2, alpha: 1 });

    // A client reordering a JSON body must not make a retry look like new work.
    expect(a).toBe(b);
  });

  it('does not vary with the key order of a nested input', () => {
    const a = deriveIdempotencyKey('req-1', 'step-1', { outer: { alpha: 1, beta: [{ x: 1, y: 2 }] } });
    const b = deriveIdempotencyKey('req-1', 'step-1', { outer: { beta: [{ y: 2, x: 1 }], alpha: 1 } });

    expect(a).toBe(b);
  });

  it('does vary when a nested value actually differs', () => {
    const a = deriveIdempotencyKey('req-1', 'step-1', { outer: { alpha: 1 } });
    const b = deriveIdempotencyKey('req-1', 'step-1', { outer: { alpha: 2 } });

    expect(a).not.toBe(b);
  });

  it('treats an absent input and an empty input as the same step', () => {
    expect(deriveIdempotencyKey('req-1', 'step-1')).toBe(deriveIdempotencyKey('req-1', 'step-1', {}));
  });

  it('carries the request and step in the clear, so a key is traceable in a log', () => {
    const key = deriveIdempotencyKey('req-1', 'step-2', {});

    expect(key.startsWith('req-1:step-2:')).toBe(true);
  });

  it('produces a Cloud Tasks safe discriminator', () => {
    const keys = stepPlanFor('create', PAYLOAD).map((entry, index) =>
      deriveIdempotencyKey('req-abc-123', `step-${index}`, entry.input),
    );

    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9:_-]+$/);
    }
  });
});

/**
 * REQ-005: the phase 3 plan.
 *
 * The plan is where two of the criteria are decided before any handler runs.
 * The diff step has to sit ahead of everything that mutates, or an approver
 * could be shown a request with no change set (AC-2); and each group change has
 * to be its own step, or one failing group would discard the rest (AC-7).
 */
describe('the update step plan', () => {
  const TARGET = { primaryEmail: 'ada.lovelace@company.com' };

  it('validates, computes the diff, then applies', () => {
    const plan = stepPlanFor('update', { ...TARGET, title: 'Principal Engineer' });

    expect(plan.map((s) => s.name)).toEqual([
      'validate-update-request',
      'compute-update-diff',
      'apply-update-attributes',
      'verify-update',
    ]);
  });

  it('puts the diff ahead of every step that mutates', () => {
    // Stated as an ordering rather than an index, so inserting a step cannot
    // quietly move the diff behind an apply.
    const plan = stepPlanFor('update', {
      ...TARGET,
      title: 'Lead',
      addGroups: ['platform@company.com'],
      removeGroups: ['research@company.com'],
    });
    const names = plan.map((s) => s.name);
    const diffAt = names.indexOf('compute-update-diff');

    for (const mutating of ['apply-update-attributes', 'add-group', 'remove-group']) {
      expect(names.indexOf(mutating)).toBeGreaterThan(diffAt);
    }
  });

  it('gives every group change its own step, named on its input', () => {
    const plan = stepPlanFor('update', {
      ...TARGET,
      addGroups: ['platform@company.com', 'oncall@company.com'],
      removeGroups: ['research@company.com'],
    });

    expect(plan.filter((s) => s.name === 'add-group').map((s) => s.input)).toEqual([
      { groupKey: 'platform@company.com' },
      { groupKey: 'oncall@company.com' },
    ]);
    expect(plan.filter((s) => s.name === 'remove-group').map((s) => s.input)).toEqual([
      { groupKey: 'research@company.com' },
    ]);
  });

  it('omits the attribute step when no attribute was submitted', () => {
    // A step that exists only to skip tells an operator a change was
    // considered when none was ever asked for.
    const plan = stepPlanFor('update', { ...TARGET, addGroups: ['platform@company.com'] });

    expect(plan.map((s) => s.name)).not.toContain('apply-update-attributes');
  });

  it('includes the attribute step when a field is being CLEARED', () => {
    // The case a truthiness check would drop. Clearing a manager is a change,
    // and dropping the step would leave the request reporting success having
    // left the relation in place.
    const plan = stepPlanFor('update', { ...TARGET, managerEmail: null });

    expect(plan.map((s) => s.name)).toContain('apply-update-attributes');
  });

  it('is pure: the same payload always produces the same plan', () => {
    const payload = { ...TARGET, title: 'Lead', addGroups: ['platform@company.com'] };

    expect(stepPlanFor('update', payload)).toEqual(stepPlanFor('update', payload));
  });

  it('refuses a group list that is not an array of non-empty strings', () => {
    for (const bad of ['platform@company.com', [''], [42], [null]]) {
      expect(() => stepPlanFor('update', { ...TARGET, addGroups: bad })).toThrow(InvalidPhasePayload);
      expect(() => stepPlanFor('update', { ...TARGET, removeGroups: bad })).toThrow(
        InvalidPhasePayload,
      );
    }
  });
});

/**
 * REQ-006: the phase 4 plan.
 *
 * The ordering IS the safety property. Suspension is the only reversible move,
 * so everything destructive has to sit behind it, and the account has to still
 * exist when its Drive is handed over.
 */
describe('the delete step plan', () => {
  const TARGET = { primaryEmail: 'ada.lovelace@company.com' };

  it('suspends, revokes, removes memberships, then deletes', () => {
    expect(stepPlanFor('delete', TARGET).map((s) => s.name)).toEqual([
      'suspend-user',
      'revoke-access',
      'remove-memberships',
      'delete-user',
    ]);
  });

  it('puts suspension first, ahead of every destructive step (AC-2)', () => {
    // Asserted as an ordering rather than an index, so inserting a step cannot
    // quietly move something destructive in front of the access cut.
    const names = stepPlanFor('delete', {
      ...TARGET,
      transferDriveTo: 'grace.hopper@company.com',
    }).map((s) => s.name);
    const suspendAt = names.indexOf('suspend-user');

    for (const destructive of ['revoke-access', 'remove-memberships', 'transfer-drive', 'delete-user']) {
      expect(names.indexOf(destructive)).toBeGreaterThan(suspendAt);
    }
  });

  it('deletes last, after the Drive transfer', () => {
    // The account has to still exist to own the files being handed over, and a
    // transfer still running against a deleted owner does not finish.
    const names = stepPlanFor('delete', {
      ...TARGET,
      transferDriveTo: 'grace.hopper@company.com',
    }).map((s) => s.name);

    expect(names[names.length - 1]).toBe('delete-user');
    expect(names.indexOf('transfer-drive')).toBeLessThan(names.indexOf('delete-user'));
  });

  it('includes the transfer step only when a successor was named', () => {
    expect(stepPlanFor('delete', TARGET).map((s) => s.name)).not.toContain('transfer-drive');
    expect(
      stepPlanFor('delete', { ...TARGET, transferDriveTo: 'grace.hopper@company.com' }).map(
        (s) => s.name,
      ),
    ).toContain('transfer-drive');
  });

  it('carries the successor on the transfer step input', () => {
    const plan = stepPlanFor('delete', { ...TARGET, transferDriveTo: 'grace.hopper@company.com' });

    expect(plan.find((s) => s.name === 'transfer-drive')!.input).toEqual({
      successor: 'grace.hopper@company.com',
    });
  });

  it('ignores an empty successor rather than planning a transfer to nobody', () => {
    expect(stepPlanFor('delete', { ...TARGET, transferDriveTo: '' }).map((s) => s.name)).not.toContain(
      'transfer-drive',
    );
  });

  it('is pure: the same payload always produces the same plan', () => {
    const payload = { ...TARGET, transferDriveTo: 'grace.hopper@company.com' };

    expect(stepPlanFor('delete', payload)).toEqual(stepPlanFor('delete', payload));
  });

  it('names the compensating step, which is in no plan', () => {
    // It is appended to a request already in flight, never planned up front:
    // there is nothing to compensate until something has been done.
    for (const phase of ['create', 'notify', 'delete'] as const) {
      const payload = phase === 'delete' ? TARGET : PAYLOAD;
      expect(stepPlanFor(phase, payload).map((s) => s.name)).not.toContain(COMPENSATING_STEP);
    }
    expect(COMPENSATING_STEP).toBe('unsuspend-user');
  });
});
