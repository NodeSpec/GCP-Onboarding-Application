import { Timestamp } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import type { ApprovalPolicy, LifecycleRequest, LifecycleStep, Phase } from './model.js';
import { resolveStepPolicy } from './policy.js';
import { deriveIdempotencyKey, type StepPlanEntry } from './stepPlans.js';

/**
 * Builds the documents a new lifecycle request is made of, without writing them.
 *
 * Separated from the store so the shape of what gets persisted can be asserted
 * directly. The transactional write needs Firestore; deciding what to write does
 * not, and that decision is where REQ-001's guarantees actually live: one step
 * per plan entry, every one 'pending' with attempt 0, each carrying a stable
 * idempotency key, and the approval policy frozen onto the request.
 *
 * Serves REQ-001 and REQ-002.
 */

export interface NewRequestInput {
  phase: Phase;
  targetUser: string;
  requestedBy: string;
  payload: Record<string, unknown>;
  plan: StepPlanEntry[];
  /** The policy in force right now. Snapshotted, never re-read later. */
  policy: ApprovalPolicy;
  /** Injectable so tests are not at the mercy of a real clock or uuid. */
  now?: () => Timestamp;
  newId?: () => string;
}

export interface NewRequestDocuments {
  request: LifecycleRequest;
  steps: LifecycleStep[];
}

export function buildNewRequest(input: NewRequestInput): NewRequestDocuments {
  const now = input.now ?? (() => Timestamp.now());
  const newId = input.newId ?? randomUUID;

  if (input.plan.length === 0) {
    // Guarded here as well as in stepPlanFor: a request with no steps would
    // never leave 'pending' and would read as a stuck job.
    throw new Error(`Refusing to create a ${input.phase} request with an empty step plan`);
  }

  const requestId = newId();
  const createdAt = now();
  const phasePolicy = input.policy[input.phase];

  const steps: LifecycleStep[] = input.plan.map((entry, ordinal) => {
    const stepId = `${String(ordinal).padStart(3, '0')}-${entry.name}`;
    return {
      stepId,
      name: entry.name,
      ordinal,
      // Every step starts pending. Nothing is dispatched by construction; the
      // caller decides what happens to the first step after the write commits.
      status: 'pending',
      attempts: 0,
      requiresApproval: resolveStepPolicy(phasePolicy, entry.name).requiresApproval,
      idempotencyKey: deriveIdempotencyKey(requestId, stepId, entry.input),
      input: entry.input,
      output: null,
      error: null,
      approval: null,
      approverNotification: null,
      startedAt: null,
      completedAt: null,
    };
  });

  const request: LifecycleRequest = {
    requestId,
    phase: input.phase,
    // 'draft', not 'pending': that is the step vocabulary. A request only
    // becomes 'running' once its first step is dispatched, which the caller
    // does after this write commits.
    status: 'draft',
    targetUser: input.targetUser.toLowerCase(),
    requestedBy: input.requestedBy.toLowerCase(),
    payload: input.payload,
    // The snapshot, DEEP COPIED. Assigning phasePolicy directly would store a
    // live reference, and a later edit to the policy document object would
    // reach into a request already in flight, which is precisely what
    // REQ-002 AC-6 forbids. In production the policy arrives from a fresh
    // Firestore read and the difference would rarely show, which is what makes
    // it worth being explicit about here.
    policySnapshot: structuredClone(phasePolicy),
    computedDiff: null,
    holdUntil: null,
    createdAt,
    updatedAt: createdAt,
  };

  return { request, steps };
}
