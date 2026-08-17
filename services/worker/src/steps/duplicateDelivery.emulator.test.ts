import { Firestore } from '@google-cloud/firestore';
import { randomBytes } from 'node:crypto';
import {
  COLLECTIONS,
  CredentialStore,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type AuditActor,
  type KeyProvider,
} from '@lifecycle/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advance } from './advance.js';
import { executeStep } from './executor.js';
import '../phases/create.js';

/**
 * TC-REQ-013-7: concurrent duplicate task deliveries for the same step result
 * in exactly one Workspace mutation.
 *
 * This is the criterion the transactional claim exists for, and the one that
 * cannot be proven any way but by racing. Cloud Tasks deduplication has a
 * window and delivers at least once; two instances CAN receive the same step
 * at the same moment. What stands between that and a double mutation is the
 * claim transaction alone, so the deliveries here are genuinely concurrent
 * and the mutation is counted at the Directory boundary.
 *
 * The mutation carries a deliberate in-flight delay. Without it the first
 * delivery could finish before the second even starts, and the test would
 * pass against a broken claim by accident of timing.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const KEY = randomBytes(32);
const keys: KeyProvider = {
  resolve: async () => ({ key: KEY, version: 'versions/1' }),
  resolveVersion: async () => ({ key: KEY, version: 'versions/1' }),
};
const credentials = new CredentialStore(db, keys);

const ACTOR: AuditActor = { kind: 'human', email: 'operator@company.com' };
const TARGET = 'ada.lovelace@company.com';
const GROUP = 'engineering@company.com';

/**
 * Counts every mutation, holds each one open long enough for a racing
 * delivery to arrive mid-flight, and reports membership as absent so the
 * handler's own read-before-mutate can never be what saves the test.
 */
class CountingDirectory {
  addMemberCalls = 0;

  async getUser(primaryEmail: string) {
    return { primaryEmail, changePasswordAtNextLogin: true };
  }

  async hasMember() {
    // Always absent. If two deliveries both reach the handler, both will
    // decide to mutate; only the claim can make that impossible.
    return false;
  }

  async addMember() {
    this.addMemberCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  reset() {
    this.addMemberCalls = 0;
  }
}

const directory = new CountingDirectory();

const silentDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

function deps() {
  return {
    store,
    directory: directory as never,
    credentials,
    advance: (requestId: string, completedStepId: string) =>
      advance({ store, dispatcher: silentDispatcher }, requestId, completedStepId),
  };
}

async function wipe() {
  for (const collection of [COLLECTIONS.requests, COLLECTIONS.audit, COLLECTIONS.credentialHandoffs]) {
    const snap = await db.collection(collection).get();
    await Promise.all(
      snap.docs.map(async (doc) => {
        const steps = await doc.ref.collection(COLLECTIONS.steps).get();
        await Promise.all(steps.docs.map((s) => s.ref.delete()));
        await doc.ref.delete();
      }),
    );
  }
}

beforeAll(wipe);
afterEach(async () => {
  directory.reset();
  await wipe();
});

/** A create request with its assign-group step released and ready to claim. */
async function readyGroupStep() {
  const payload = {
    primaryEmail: TARGET,
    givenName: 'Ada',
    familyName: 'Lovelace',
    groups: [GROUP],
  };
  const documents = buildNewRequest({
    phase: 'create',
    targetUser: TARGET,
    requestedBy: 'operator@company.com',
    payload,
    plan: stepPlanFor('create', payload),
    policy: DEFAULT_POLICY,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);

  const step = documents.steps.find((s) => s.name === 'assign-group')!;
  await store.transitionStep({
    requestId: documents.request.requestId,
    stepId: step.stepId,
    expectedFrom: 'pending',
    to: 'ready',
    audit: { actor: ACTOR, action: 'step.ready' },
  });

  return { requestId: documents.request.requestId, stepId: step.stepId };
}

describe('AC-7: concurrent duplicate deliveries mutate exactly once', () => {
  it('two simultaneous deliveries produce one addMember call', async () => {
    const { requestId, stepId } = await readyGroupStep();

    const [a, b] = await Promise.all([
      executeStep(deps(), { requestId, stepId, attempt: 1 }),
      executeStep(deps(), { requestId, stepId, attempt: 1 }),
    ]);

    expect(directory.addMemberCalls).toBe(1);

    // One delivery did the work; the other was told the step was not claimable
    // and did nothing. Which is which depends on the race, so sort by kind.
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['not-claimable', 'settled']);
  });

  it('five simultaneous deliveries still produce one addMember call', async () => {
    // Five rather than two: a claim that loses the race some of the time can
    // survive a two-way test on luck alone.
    const { requestId, stepId } = await readyGroupStep();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => executeStep(deps(), { requestId, stepId, attempt: 1 })),
    );

    expect(directory.addMemberCalls).toBe(1);
    expect(outcomes.filter((o) => o.kind === 'settled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'not-claimable')).toHaveLength(4);
  });

  it('a delivery arriving while the handler is mid-mutation is refused', async () => {
    // The sharpest version of the race: the second delivery arrives when the
    // first is provably INSIDE the Workspace call, which is when a broken
    // claim would let a duplicate straight through into a second mutation.
    const { requestId, stepId } = await readyGroupStep();

    const first = executeStep(deps(), { requestId, stepId, attempt: 1 });
    // The mutation holds itself open for 150ms; land the duplicate inside it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await executeStep(deps(), { requestId, stepId, attempt: 2 });

    expect(second.kind).toBe('not-claimable');
    await first;
    expect(directory.addMemberCalls).toBe(1);
  });

  it('settles the step exactly once, with the winner recorded as one claim', async () => {
    const { requestId, stepId } = await readyGroupStep();

    await Promise.all(
      Array.from({ length: 5 }, () => executeStep(deps(), { requestId, stepId, attempt: 1 })),
    );

    const events = await store.listAudit(requestId);
    // One claim won, one settle followed. Five claims recorded would mean the
    // transaction was not actually deciding anything.
    expect(events.filter((e) => e.action === 'step.claim' && e.stepId === stepId)).toHaveLength(1);
    expect(events.filter((e) => e.action === 'step.succeeded' && e.stepId === stepId)).toHaveLength(1);
  });
});
