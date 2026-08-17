import { describe, expect, it } from 'vitest';
import { InvalidPhasePayload, deriveIdempotencyKey, stepPlanFor } from './stepPlans.js';

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

  it.each(['update', 'delete'] as const)('refuses the unimplemented %s phase', (phase) => {
    // An empty plan would persist a request with no steps, which sits in
    // pending forever looking like a stuck job rather than an unbuilt one.
    expect(() => stepPlanFor(phase, PAYLOAD)).toThrow(InvalidPhasePayload);
  });

  it('plans the notify phase as validate then send', () => {
    // Sending is ONE step: splitting render from deliver would create a step
    // that can succeed while the person still hears nothing (REQ-004).
    expect(stepPlanFor('notify', PAYLOAD).map((s) => s.name)).toEqual([
      'validate-notify-request',
      'send-welcome-letter',
    ]);
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
