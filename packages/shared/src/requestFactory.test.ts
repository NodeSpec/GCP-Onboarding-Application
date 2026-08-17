import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, normalisePolicy, resolveStepPolicy } from './policy.js';
import { buildNewRequest } from './requestFactory.js';
import { stepPlanFor } from './stepPlans.js';

/**
 * TC-REQ-001-1 and TC-REQ-001-3, plus TC-REQ-002-6.
 *
 * What gets written is decided here and written by the store. Asserting the
 * documents directly means the guarantees REQ-001 is about are checked against
 * real output rather than against a Firestore fake that would only prove the
 * fake works. The transactional write and the concurrency guard are a separate
 * concern and belong to the emulator suite.
 */

const PAYLOAD = {
  primaryEmail: 'Ada.Lovelace@Company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  groups: ['engineering@company.com', 'platform@company.com'],
};

const FIXED = Timestamp.fromMillis(1_700_000_000_000);

function build(overrides: Partial<Parameters<typeof buildNewRequest>[0]> = {}) {
  let counter = 0;
  return buildNewRequest({
    phase: 'create',
    targetUser: PAYLOAD.primaryEmail,
    requestedBy: 'Operator@Company.com',
    payload: PAYLOAD,
    plan: stepPlanFor('create', PAYLOAD),
    policy: DEFAULT_POLICY,
    now: () => FIXED,
    newId: () => `req-${(counter += 1)}`,
    ...overrides,
  });
}

describe('AC-1: one step document per plan entry, all pending with attempt 0', () => {
  it('emits exactly one step per entry in the plan, in order', () => {
    const plan = stepPlanFor('create', PAYLOAD);
    const { steps } = build();

    expect(steps).toHaveLength(plan.length);
    expect(steps.map((s) => s.name)).toEqual(plan.map((e) => e.name));
    expect(steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('starts every step pending with no attempts and nothing recorded', () => {
    for (const step of build().steps) {
      expect(step.status).toBe('pending');
      expect(step.attempts).toBe(0);
      expect(step.output).toBeNull();
      expect(step.error).toBeNull();
      expect(step.approval).toBeNull();
      expect(step.startedAt).toBeNull();
      expect(step.completedAt).toBeNull();
    }
  });

  it('starts the request in draft, so nothing is dispatched by construction', () => {
    const { request } = build();

    expect(request.status).toBe('draft');
    expect(request.computedDiff).toBeNull();
    expect(request.holdUntil).toBeNull();
  });

  it('carries each step its own snapshotted input', () => {
    const groupSteps = build().steps.filter((s) => s.name === 'assign-group');

    expect(groupSteps.map((s) => s.input.groupKey)).toEqual(PAYLOAD.groups);
  });

  it('gives steps sortable ids, so the operator timeline needs no separate ordering', () => {
    expect(build().steps.map((s) => s.stepId)).toEqual([
      '000-validate-request',
      '001-create-user',
      '002-apply-attributes',
      '003-assign-group',
      '004-assign-group',
      '005-verify-account',
    ]);
  });

  it('normalises the target and requester, so casing cannot fork an identity', () => {
    const { request } = build();

    expect(request.targetUser).toBe('ada.lovelace@company.com');
    expect(request.requestedBy).toBe('operator@company.com');
  });

  it('refuses an empty plan rather than persisting a request with no steps', () => {
    expect(() => build({ plan: [] })).toThrow(/empty step plan/);
  });
});

describe('AC-3: every step carries a stable, distinct idempotency key', () => {
  it('gives every step a key', () => {
    for (const step of build().steps) {
      expect(step.idempotencyKey).toBeTruthy();
    }
  });

  it('gives no two steps of a request the same key', () => {
    const keys = build().steps.map((s) => s.idempotencyKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives two requests for the same payload entirely disjoint keys', () => {
    let counter = 0;
    const nextId = () => `req-${(counter += 1)}`;
    const first = build({ newId: nextId });
    const second = build({ newId: nextId });

    const overlap = first.steps
      .map((s) => s.idempotencyKey)
      .filter((k) => second.steps.some((s) => s.idempotencyKey === k));

    expect(overlap).toEqual([]);
  });

  it('derives the key from the step id, so rebuilding the same request reproduces it', () => {
    const a = build({ newId: () => 'req-fixed' });
    const b = build({ newId: () => 'req-fixed' });

    expect(a.steps.map((s) => s.idempotencyKey)).toEqual(b.steps.map((s) => s.idempotencyKey));
  });
});

describe('REQ-002 AC-6: approval policy is snapshotted at creation', () => {
  it('copies the phase policy onto the request rather than referencing it', () => {
    const policy = {
      ...DEFAULT_POLICY,
      create: { 'create-user': { requiresApproval: true, approverRole: 'admin' as const } },
    };
    const { request } = build({ policy });

    expect(request.policySnapshot).toEqual(policy.create);
  });

  it('leaves an in-flight request untouched when the live policy is later edited', () => {
    const policy = {
      ...DEFAULT_POLICY,
      create: { 'create-user': { requiresApproval: true, approverRole: 'approver' as const } },
    };
    const { request, steps } = build({ policy });

    // The edit happens after creation. Mutating the source object is the most
    // direct way to prove the snapshot is a copy and not a live reference.
    policy.create['create-user'].requiresApproval = false;

    expect(request.policySnapshot['create-user']!.requiresApproval).toBe(true);
    expect(steps.find((s) => s.name === 'create-user')!.requiresApproval).toBe(true);
  });

  it('marks each step with whether it needs approval, resolved from the snapshot', () => {
    const policy = {
      ...DEFAULT_POLICY,
      create: { 'verify-account': { requiresApproval: true, approverRole: 'approver' as const } },
    };
    const { steps } = build({ policy });

    expect(steps.filter((s) => s.requiresApproval).map((s) => s.name)).toEqual(['verify-account']);
  });

  it('treats a step absent from the policy as needing no approval', () => {
    expect(resolveStepPolicy({}, 'anything').requiresApproval).toBe(false);
    expect(resolveStepPolicy(undefined, 'anything').requiresApproval).toBe(false);
  });
});

describe('policy document handling', () => {
  it('fills every phase when the stored document is partial', () => {
    const normalised = normalisePolicy({ create: { 'create-user': { requiresApproval: true, approverRole: 'admin' } } });

    expect(Object.keys(normalised).sort()).toEqual(['create', 'delete', 'notify', 'update']);
    expect(normalised.delete).toEqual(DEFAULT_POLICY.delete);
  });

  it('falls back to the default when no document exists', () => {
    expect(normalisePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(normalisePolicy(null)).toEqual(DEFAULT_POLICY);
  });

  it('defaults the destructive phases to requiring approval', () => {
    // A missing policy document means "not configured yet" far more often than
    // "approval intentionally disabled", so the absent control still applies.
    expect(DEFAULT_POLICY.delete['delete-user']!.requiresApproval).toBe(true);
    expect(DEFAULT_POLICY.delete['delete-user']!.approverRole).toBe('admin');
  });
});
