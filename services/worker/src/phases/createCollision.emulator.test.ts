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
import { advance } from '../steps/advance.js';
import { executeStep } from '../steps/executor.js';
import { UserAlreadyExistsError } from '../workspace/directoryClient.js';
import './create.js';

/**
 * TC-REQ-003-3: a creation request for a primary email that already exists
 * fails validation before anything is mutated, and the request terminates in
 * 'failed' carrying a typed AlreadyExists error.
 *
 * Three separate claims, and the one most easily faked is the middle one.
 * "Before any mutation is attempted" cannot be shown by observing the end
 * state, because a run that mutated and then failed can leave a domain that
 * looks the same as one that never touched it. So every mutating Directory
 * method here counts its calls and the assertion is that the counter is zero,
 * not that the domain looks untouched.
 *
 * The typed part matters for the same reason it exists: an operator who
 * submitted a duplicate email has to be able to tell that from a Workspace
 * outage, and the only alternative to a stable error code is parsing the
 * message text.
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

const OPERATOR = 'operator@company.com';
const ACTOR: AuditActor = { kind: 'human', email: OPERATOR };
const TAKEN = 'ada.lovelace@company.com';
const GROUP = 'engineering@company.com';

/**
 * Reports the account as already present and counts every call that would
 * change the domain. Read methods are free; the mutating three are the ones
 * the criterion is about.
 */
class CollidingDirectory {
  exists = true;
  mutations: string[] = [];

  async getUser(primaryEmail: string) {
    if (!this.exists) return null;
    return {
      id: 'existing-workspace-id',
      primaryEmail,
      orgUnitPath: '/',
      changePasswordAtNextLogin: true,
      organizations: [],
    };
  }

  async insertUser(input: { primaryEmail: string }) {
    this.mutations.push(`insertUser:${input.primaryEmail}`);
    return { id: 'should-never-be-created', primaryEmail: input.primaryEmail };
  }

  async updateUser(primaryEmail: string) {
    this.mutations.push(`updateUser:${primaryEmail}`);
    return {};
  }

  async addMember(groupKey: string, primaryEmail: string) {
    this.mutations.push(`addMember:${groupKey}:${primaryEmail}`);
  }

  async hasMember() {
    return true;
  }

  generateInitialPassword(length = 24): string {
    return randomBytes(length).toString('base64url').slice(0, length);
  }

  reset() {
    this.exists = true;
    this.mutations = [];
  }
}

const directory = new CollidingDirectory();

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

/** Submits a create request and runs its first step, which is validation. */
async function submitAndValidate() {
  const payload = {
    primaryEmail: TAKEN,
    givenName: 'Ada',
    familyName: 'Lovelace',
    groups: [GROUP],
  };
  const documents = buildNewRequest({
    phase: 'create',
    targetUser: TAKEN,
    requestedBy: OPERATOR,
    payload,
    plan: stepPlanFor('create', payload),
    policy: DEFAULT_POLICY,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);

  const requestId = documents.request.requestId;
  const stepId = documents.steps[0]!.stepId;
  const outcome = await executeStep(deps(), { requestId, stepId, attempt: 1 });

  return { requestId, stepId, outcome, plan: documents.steps };
}

describe('AC-3: a colliding primary email fails validation', () => {
  it('records a typed AlreadyExists error on the step', async () => {
    const { requestId, stepId } = await submitAndValidate();

    const step = (await store.listSteps(requestId)).find((s) => s.stepId === stepId)!;

    expect(step.status).toBe('failed');
    // The class an operator's own bad input earns, and a code stable enough to
    // branch on. 'terminal'/'terminal' would have been true and unusable.
    expect(step.error).toMatchObject({ class: 'validation', code: 'already_exists' });
    // The message names the address, so the operator knows which field to fix.
    expect(step.error!.message).toContain(TAKEN);
  });

  it('terminates the request in failed', async () => {
    const { requestId } = await submitAndValidate();

    expect((await store.getRequest(requestId))!.status).toBe('failed');
  });

  it('attempts no mutation whatsoever', async () => {
    // The criterion's real content. Counted at the Directory boundary rather
    // than inferred from the resulting domain, because a run that mutated and
    // then failed can leave state indistinguishable from one that did not.
    await submitAndValidate();

    expect(directory.mutations).toEqual([]);
  });

  it('leaves every later step pending and writes no credential', async () => {
    const { requestId, plan } = await submitAndValidate();

    const steps = await store.listSteps(requestId);
    expect(steps.slice(1).every((s) => s.status === 'pending' && s.attempts === 0)).toBe(true);
    expect(steps).toHaveLength(plan.length);

    // create-user never ran, so nothing was generated to stash. A record here
    // would mean a password was issued for an account that was never made.
    expect((await db.collection(COLLECTIONS.credentialHandoffs).get()).size).toBe(0);
  });

  it('settles instead of asking Cloud Tasks to redeliver', async () => {
    // A collision does not heal on retry. Returning 'retry' would spend the
    // whole budget re-reading the same account before failing anyway.
    const { outcome } = await submitAndValidate();

    expect(outcome).toEqual({ kind: 'settled', status: 'failed' });
  });

  it('audits the failure at both the step and the request', async () => {
    const { requestId } = await submitAndValidate();

    const events = await store.listAudit(requestId);
    const stepFailed = events.find((e) => e.action === 'step.failed')!;
    const requestFailed = events.find((e) => e.action === 'request.failed')!;

    expect(stepFailed.outcome).toBe('failure');
    expect(requestFailed.outcome).toBe('failure');
    expect(JSON.stringify(requestFailed.after)).toContain('validate-request');
  });

  it('is the collision that caused this: the same run proceeds when the address is free', async () => {
    // The control. Without it every assertion above would also hold for a
    // validation step that failed for some unrelated reason.
    directory.exists = false;

    const { requestId, stepId } = await submitAndValidate();
    const step = (await store.listSteps(requestId)).find((s) => s.stepId === stepId)!;

    expect(step.status).toBe('succeeded');
    expect(step.error).toBeNull();
    expect((await store.getRequest(requestId))!.status).toBe('running');
  });
});

describe('the error type carries the classification, not the call site', () => {
  it('is a UserAlreadyExistsError naming the address and the operation', () => {
    // Constructed directly, because the executor only ever sees it as a
    // classified step error and the type's own contract would otherwise go
    // unasserted.
    const err = new UserAlreadyExistsError(TAKEN, 'validate-request');

    expect(err).toBeInstanceOf(UserAlreadyExistsError);
    expect(err.name).toBe('UserAlreadyExistsError');
    expect(err.primaryEmail).toBe(TAKEN);
    expect(err.operation).toBe('validate-request');
    // 'conflict' is not in the retryable set, which is what stops the executor
    // handing the step back to 'ready' for another delivery.
    expect(err.errorClass).toBe('conflict');
    expect(err.status).toBe(409);
  });
});
