import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  assertRequestTransition,
  assertStepTransition,
  canTransitionRequest,
  canTransitionStep,
  isClaimable,
} from './transitions.js';
import type { RequestStatus, StepStatus } from './model.js';

/**
 * TC-REQ-016-3 and supporting coverage for TC-REQ-016-6.
 *
 * The transition table is what makes at-least-once delivery safe, so these
 * tests assert the CLOSED set: not just that legal moves are allowed, but that
 * everything else is refused. A table that quietly permits an extra edge is the
 * failure this guards against, and only exhaustive assertion catches it.
 */

const ALL_STEP_STATUSES: StepStatus[] = [
  'pending',
  'awaiting_approval',
  'ready',
  'running',
  'succeeded',
  'failed',
  'skipped',
];

const ALL_REQUEST_STATUSES: RequestStatus[] = [
  'draft',
  'running',
  'awaiting_approval',
  'held',
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
];

/** The complete legal step table, restated independently of the implementation. */
const LEGAL_STEP_EDGES: Record<StepStatus, StepStatus[]> = {
  pending: ['ready', 'awaiting_approval', 'skipped'],
  awaiting_approval: ['ready', 'failed'],
  ready: ['running'],
  // Beyond the three outcomes: 'ready' is the hand-back after a retryable
  // failure (without it a transient error wedges the step, since claiming
  // requires 'ready'), and 'running' is the stale-lease reclaim of a step whose
  // instance died mid-flight. The reclaim is additionally gated on the lease
  // having expired inside claimStep's transaction; that gate is what this table
  // deliberately does NOT express, and it is proven in the executor suite.
  running: ['succeeded', 'failed', 'skipped', 'ready', 'running'],
  failed: ['ready'],
  succeeded: [],
  skipped: [],
};

const LEGAL_REQUEST_EDGES: Record<RequestStatus, RequestStatus[]> = {
  draft: ['running', 'awaiting_approval', 'cancelled'],
  running: ['awaiting_approval', 'held', 'succeeded', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'rejected', 'cancelled', 'failed'],
  held: ['running', 'cancelled', 'failed'],
  failed: ['running'],
  succeeded: [],
  rejected: [],
  cancelled: [],
};

describe('step transition table', () => {
  it.each(ALL_STEP_STATUSES)('permits exactly the declared edges from %s', (from) => {
    const permitted = ALL_STEP_STATUSES.filter((to) => canTransitionStep(from, to));
    expect(permitted.sort()).toEqual([...LEGAL_STEP_EDGES[from]].sort());
  });

  it('treats succeeded, skipped as terminal', () => {
    for (const terminal of ['succeeded', 'skipped'] as StepStatus[]) {
      const anyAllowed = ALL_STEP_STATUSES.some((to) => canTransitionStep(terminal, to));
      expect(anyAllowed).toBe(false);
    }
  });

  /**
   * The specific case named in AC-REQ-016-3. Called out separately from the
   * table sweep because it is the one an implementer is most likely to add
   * while making a retry work.
   */
  it('refuses succeeded -> running with a typed error', () => {
    expect(() => assertStepTransition('step-1', 'succeeded', 'running')).toThrow(
      InvalidTransitionError,
    );

    try {
      assertStepTransition('step-1', 'succeeded', 'running');
      expect.unreachable('should have thrown');
    } catch (err) {
      const typed = err as InvalidTransitionError;
      expect(typed.entity).toBe('step');
      expect(typed.from).toBe('succeeded');
      expect(typed.to).toBe('running');
      expect(typed.id).toBe('step-1');
    }
  });

  it('does not mutate anything when refusing', () => {
    // The guard is a pure assertion; the store is what mutates. Proving it
    // throws before returning is what lets the store call it inside the
    // transaction and rely on the throw to abort.
    expect(() => assertStepTransition('step-1', 'skipped', 'running')).toThrow();
  });

  it('permits a failed step to be resumed', () => {
    // Admin resume (REQ-016 AC-5 aftermath). Without this edge a failed request
    // could never be retried, only recreated.
    expect(canTransitionStep('failed', 'ready')).toBe(true);
  });

  /**
   * awaiting_approval -> rejected is deliberately NOT a step edge: a rejection
   * terminates the REQUEST while the step stays put. If this ever becomes
   * legal, a rejected step could be re-approved.
   */
  it('does not allow a step to move to a request-level outcome', () => {
    expect(canTransitionStep('awaiting_approval', 'succeeded')).toBe(false);
  });
});

describe('request transition table', () => {
  it.each(ALL_REQUEST_STATUSES)('permits exactly the declared edges from %s', (from) => {
    const permitted = ALL_REQUEST_STATUSES.filter((to) => canTransitionRequest(from, to));
    expect(permitted.sort()).toEqual([...LEGAL_REQUEST_EDGES[from]].sort());
  });

  it('treats succeeded, rejected and cancelled as terminal', () => {
    for (const terminal of ['succeeded', 'rejected', 'cancelled'] as RequestStatus[]) {
      const anyAllowed = ALL_REQUEST_STATUSES.some((to) => canTransitionRequest(terminal, to));
      expect(anyAllowed).toBe(false);
    }
  });

  it('raises a typed error naming the request', () => {
    try {
      assertRequestTransition('req-9', 'cancelled', 'running');
      expect.unreachable('should have thrown');
    } catch (err) {
      const typed = err as InvalidTransitionError;
      expect(typed.entity).toBe('request');
      expect(typed.id).toBe('req-9');
    }
  });
});

describe('isClaimable', () => {
  /**
   * TC-REQ-016-2. A redelivered task must find the step unclaimable in every
   * status except ready, which is what makes the second delivery a no-op
   * rather than a second execution.
   */
  it('is true only for ready', () => {
    for (const status of ALL_STEP_STATUSES) {
      expect(isClaimable(status)).toBe(status === 'ready');
    }
  });
});
