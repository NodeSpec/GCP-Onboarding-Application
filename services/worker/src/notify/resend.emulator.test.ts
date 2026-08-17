import { Firestore, Timestamp } from '@google-cloud/firestore';
import { randomBytes } from 'node:crypto';
import {
  COLLECTIONS,
  CredentialStore,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type AuditEvent,
  type CredentialHandoff,
  type KeyProvider,
  type LifecycleStep,
} from '@lifecycle/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryReceipt, Message, NotificationSender } from './sender.js';
import { advance } from '../steps/advance.js';
import { executeStep } from '../steps/executor.js';
import { useNotificationSender } from '../phases/notify.js';
import '../phases/create.js';
import '../phases/notify.js';

/**
 * TC-REQ-030-1 through TC-REQ-030-9: the welcome letter resend, and the
 * credential regeneration that makes a resend possible after the original
 * one-time password is gone.
 *
 * Against the emulator because almost every claim here is about what is
 * DURABLE across separate requests: a credential written by one request and
 * reused by another, a record that stops being retrievable once a later request
 * replaced it, an audit trail that has to still be readable afterwards. None of
 * that is observable in a fake.
 *
 * AC-5's status code belongs to the retrieval route, which lives in the API
 * service, and is asserted there against real HTTP. What belongs here is the
 * state that makes it a 410: a record that can no longer produce a password.
 *
 * Substituted: the mail provider and the Directory API. Everything else,
 * including the encryption, is real.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

/** A fixed key, so a failure is never a flaky key generation. */
const KEY = randomBytes(32);
const keys: KeyProvider = {
  resolve: async () => ({ key: KEY, version: 'versions/1' }),
  resolveVersion: async () => ({ key: KEY, version: 'versions/1' }),
};
const credentials = new CredentialStore(db, keys);

const OPERATOR = 'operator@company.com';
const ACTOR: AuditActor = { kind: 'human', email: OPERATOR };
const TARGET = 'ada.lovelace@company.com';

const NOTIFY_PAYLOAD = {
  primaryEmail: TARGET,
  givenName: 'Ada',
  familyName: 'Lovelace',
  notificationEmail: 'ada.personal@example.com',
  regenerate: false,
};

class RecordingSender implements NotificationSender {
  sent: Message[] = [];
  private next = 0;

  async send(message: Message): Promise<DeliveryReceipt> {
    this.sent.push(message);
    this.next += 1;
    return { deliveryId: `delivery-${this.next}`, bounceReportingAvailable: false };
  }
}

/**
 * The Directory API stand-in. Records every mutation, so "no Workspace call was
 * made" is a claim this file can actually check rather than assume.
 */
class FakeDirectory {
  exists = true;
  resets: { primaryEmail: string; password: string }[] = [];
  private issued = 0;

  async getUser(primaryEmail: string) {
    return this.exists ? { primaryEmail, changePasswordAtNextLogin: true } : null;
  }

  async resetPassword(primaryEmail: string, password: string) {
    this.resets.push({ primaryEmail, password });
  }

  generateInitialPassword(): string {
    this.issued += 1;
    return `generated-password-${this.issued}`;
  }

  reset() {
    this.exists = true;
    this.resets = [];
  }
}

let sender: RecordingSender;
const directory = new FakeDirectory();

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

// ------------------------------------------------------------------- fixtures

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

beforeAll(() => {
  sender = new RecordingSender();
  useNotificationSender(sender);
});

/** A settled create request that left a credential behind, as Phase 1 does. */
async function createdAccount(requestId = 'create-request'): Promise<string> {
  const documents = buildNewRequest({
    phase: 'create',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload: { primaryEmail: TARGET, givenName: 'Ada', familyName: 'Lovelace' },
    plan: stepPlanFor('create', { primaryEmail: TARGET }),
    policy: DEFAULT_POLICY,
    newId: () => requestId,
  });
  await store.createRequest(documents, ACTOR);
  await credentials.stash({
    requestId,
    primaryEmail: TARGET,
    password: 'original-one-time-password',
    ttlHours: 72,
  });
  // Settled, so the in-flight guard does not refuse the resend that follows.
  await store.cancelRequest({ requestId, actor: ACTOR, reason: 'fixture' });
  return requestId;
}

async function notifyRequest(
  overrides: Partial<typeof NOTIFY_PAYLOAD> = {},
  policy: ApprovalPolicy = DEFAULT_POLICY,
) {
  const payload = { ...NOTIFY_PAYLOAD, ...overrides };
  const documents = buildNewRequest({
    phase: 'notify',
    targetUser: TARGET,
    requestedBy: OPERATOR,
    payload,
    plan: stepPlanFor('notify', payload),
    policy,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);
  return { requestId: documents.request.requestId, steps: documents.steps };
}

/** Runs a notify request to completion, one step at a time. */
async function runNotify(
  overrides: Partial<typeof NOTIFY_PAYLOAD> = {},
  policy: ApprovalPolicy = DEFAULT_POLICY,
) {
  const { requestId, steps } = await notifyRequest(overrides, policy);
  for (const step of steps) {
    const current = await stepOf(requestId, step.stepId);
    if (current.status !== 'ready') break;
    await executeStep(deps(), { requestId, stepId: step.stepId, attempt: 1 });
  }
  return { requestId, steps };
}

/**
 * Stages the one failure the idempotency records exist to survive: the work
 * landed and its record was committed, then the instance died before the step
 * settled. The lease expires and the next delivery reclaims the step.
 */
async function staleLease(requestId: string, stepId: string): Promise<void> {
  await db
    .collection(COLLECTIONS.requests)
    .doc(requestId)
    .collection(COLLECTIONS.steps)
    .doc(stepId)
    .update({ status: 'running', startedAt: Timestamp.fromMillis(Date.now() - 3_600_000) });
}

async function stepOf(requestId: string, stepId: string): Promise<LifecycleStep> {
  const snap = await db
    .collection(COLLECTIONS.requests)
    .doc(requestId)
    .collection(COLLECTIONS.steps)
    .doc(stepId)
    .get();
  return snap.data() as LifecycleStep;
}

async function stepNamed(requestId: string, name: string): Promise<LifecycleStep> {
  const steps = await store.listSteps(requestId);
  return steps.find((s) => s.name === name)!;
}

async function handoff(requestId: string): Promise<CredentialHandoff | undefined> {
  const snap = await db.collection(COLLECTIONS.credentialHandoffs).doc(requestId).get();
  return snap.exists ? (snap.data() as CredentialHandoff) : undefined;
}

async function auditFor(requestId: string): Promise<AuditEvent[]> {
  return store.listAudit(requestId);
}

// ------------------------------------------------------------------- AC-1

describe('AC-1: a resend is admitted against an account that already exists', () => {
  it('runs a notify request to completion for an existing user', async () => {
    await createdAccount();

    const { requestId } = await runNotify();

    expect((await store.getRequest(requestId))!.status).not.toBe('failed');
    expect((await stepNamed(requestId, 'send-welcome-letter')).status).toBe('succeeded');
    expect(sender.sent.at(-1)!.to).toEqual(['ada.personal@example.com']);
  });

  it('refuses the same account under the create phase, on the same directory', async () => {
    // The positive control. Without it, "notify was not blocked" could just mean
    // the directory stub reported the account absent. Same stub, same account:
    // create refuses on the collision, notify does not (REQ-003 vs REQ-030).
    const documents = buildNewRequest({
      phase: 'create',
      targetUser: TARGET,
      requestedBy: OPERATOR,
      payload: { primaryEmail: TARGET, givenName: 'Ada', familyName: 'Lovelace' },
      plan: stepPlanFor('create', { primaryEmail: TARGET }),
      policy: DEFAULT_POLICY,
    });
    await store.createRequest(documents, ACTOR);
    const started = await store.startFirstStep(documents.request.requestId, ACTOR);

    await executeStep(deps(), {
      requestId: documents.request.requestId,
      stepId: started.step.stepId,
      attempt: 1,
    });

    const validate = await stepOf(documents.request.requestId, started.step.stepId);
    expect(validate.status).toBe('failed');
    expect(validate.error!.message).toContain('already exists');
  });

  it('reaches the send step without ever running the create collision check', async () => {
    await createdAccount();

    const { requestId } = await runNotify();
    const names = (await store.listSteps(requestId)).map((s) => s.name);

    expect(names).not.toContain('validate-request');
    expect(names).toContain('validate-notify-request');
  });
});

// ------------------------------------------------------------------- AC-2

describe('AC-2: a resend is not suppressed by the previous send', () => {
  it('sends a second letter with its own delivery id', async () => {
    await createdAccount();
    const before = sender.sent.length;

    const first = await runNotify();
    const second = await runNotify();

    expect(sender.sent.length).toBe(before + 2);

    const firstRecord = (await stepNamed(first.requestId, 'send-welcome-letter')).notification!;
    const secondRecord = (await stepNamed(second.requestId, 'send-welcome-letter')).notification!;

    // The idempotency record lives on the STEP, and a resend is a new request
    // with its own steps. That is what makes a deliberate resend possible
    // without weakening the suppression a redelivery relies on (REQ-004 AC-3).
    expect(firstRecord.deliveryId).not.toBe(secondRecord.deliveryId);
    expect(secondRecord.deliveryId).not.toBeNull();
  });

  it('still suppresses a redelivery of the SAME step', async () => {
    // The distinction the criterion rests on. A resend must send again; a
    // redelivered task must not. Both are checked here so a change that made
    // resending work by weakening idempotency would fail this.
    await createdAccount();
    const { requestId } = await runNotify();
    const sendStep = await stepNamed(requestId, 'send-welcome-letter');
    const before = sender.sent.length;

    // The crash case, staged directly: the send landed and the record was
    // written, but the step never settled. A stale lease is what a redelivery
    // reclaims. Written through Firestore rather than transitionStep because a
    // settled step has no legal move back, which is the point.
    await staleLease(requestId, sendStep.stepId);
    await executeStep(deps(), { requestId, stepId: sendStep.stepId, attempt: 2 });

    expect(sender.sent.length).toBe(before);
    expect((await stepOf(requestId, sendStep.stepId)).status).toBe('skipped');
  });
});

// ------------------------------------------------------------------- AC-3

describe('AC-3: a resend without regeneration reuses the stored credential', () => {
  it('points the new request at the credential the create request produced', async () => {
    const createId = await createdAccount();

    const { requestId } = await runNotify();
    const step = await stepNamed(requestId, 'confirm-credential');

    expect(step.status).toBe('succeeded');
    expect(step.credential).toMatchObject({
      credentialRequestId: createId,
      rotatedAt: null,
      supersededRequestId: null,
    });
  });

  it('resets no password, because reuse is not regeneration', async () => {
    await createdAccount();

    await runNotify();

    expect(directory.resets).toEqual([]);
  });

  it('leaves the reused record retrievable, so the operator can still hand it over', async () => {
    const createId = await createdAccount();

    await runNotify();

    expect((await handoff(createId))!.oneTimePasswordCiphertext).not.toBe('');
    expect((await handoff(createId))!.retrievedAt).toBeNull();
  });

  it('refuses when the credential has already been retrieved', async () => {
    const createId = await createdAccount();
    await credentials.retrieveOnce(createId);

    const { requestId } = await runNotify();
    const step = await stepNamed(requestId, 'confirm-credential');

    expect(step.status).toBe('failed');
    expect(step.error!.code).toBe('credential_unavailable');
    expect(step.error!.class).toBe('terminal');
  });

  it('refuses when the credential has expired', async () => {
    const createId = await createdAccount();
    await db
      .collection(COLLECTIONS.credentialHandoffs)
      .doc(createId)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });

    const { requestId } = await runNotify();

    expect((await stepNamed(requestId, 'confirm-credential')).error!.code).toBe(
      'credential_unavailable',
    );
  });

  it('sends nothing when the credential check refuses', async () => {
    // The whole point of checking before sending. A letter saying "your password
    // is coming by another channel" is worse than no letter when no password can
    // be produced.
    const createId = await createdAccount();
    await credentials.retrieveOnce(createId);
    const before = sender.sent.length;

    const { requestId } = await runNotify();

    expect(sender.sent.length).toBe(before);
    expect((await stepNamed(requestId, 'send-welcome-letter')).status).toBe('pending');
  });

  it('names regeneration as the remedy in the failure an operator reads', async () => {
    const createId = await createdAccount();
    await credentials.retrieveOnce(createId);

    const { requestId } = await runNotify();

    expect((await stepNamed(requestId, 'confirm-credential')).error!.message).toContain(
      'regenerate=true',
    );
  });

  it('does not burn the retry budget on a condition no retry can change', async () => {
    const createId = await createdAccount();
    await credentials.retrieveOnce(createId);

    const { requestId, steps } = await notifyRequest();
    await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
    const outcome = await executeStep(deps(), { requestId, stepId: steps[1]!.stepId, attempt: 1 });

    expect(outcome).toMatchObject({ kind: 'settled', status: 'failed' });
  });
});

// ------------------------------------------------------------------- AC-4

describe('AC-4: regeneration sets a fresh password and replaces the record', () => {
  it('resets the Workspace password on the target account', async () => {
    await createdAccount();

    await runNotify({ regenerate: true });

    expect(directory.resets).toHaveLength(1);
    expect(directory.resets[0]!.primaryEmail).toBe(TARGET);
  });

  it('writes new ciphertext under the resend request, decrypting to the new password', async () => {
    await createdAccount();

    const { requestId } = await runNotify({ regenerate: true });
    const issued = directory.resets[0]!.password;

    const retrieved = await credentials.retrieveOnce(requestId);
    expect(retrieved).toEqual({ primaryEmail: TARGET, password: issued });
  });

  it('gives the new record its own TTL rather than inheriting the old expiry', async () => {
    const createId = await createdAccount();
    const originalExpiry = (await handoff(createId))!.expiresAt.toMillis();

    const { requestId } = await runNotify({ regenerate: true });

    // A regenerated credential that expired when the original would have is not
    // a fresh credential; the operator could get one they cannot retrieve.
    expect((await handoff(requestId))!.expiresAt.toMillis()).toBeGreaterThan(originalExpiry);
  });

  it('invalidates the record it replaced, in the same commit', async () => {
    const createId = await createdAccount();

    const { requestId } = await runNotify({ regenerate: true });

    const old = (await handoff(createId))!;
    expect(old.oneTimePasswordCiphertext).toBe('');
    expect(old.supersededAt).not.toBeNull();
    expect(old.supersededBy).toBe(requestId);
  });

  it('records the rotation on the step, naming both records', async () => {
    const createId = await createdAccount();

    const { requestId } = await runNotify({ regenerate: true });
    const step = await stepNamed(requestId, 'regenerate-credential');

    expect(step.credential).toMatchObject({
      credentialRequestId: requestId,
      supersededRequestId: createId,
    });
    expect(step.credential!.rotatedAt).not.toBeNull();
  });

  it('regenerates even when nothing was left to supersede', async () => {
    // The usual reason to regenerate: the original credential is already gone.
    const createId = await createdAccount();
    await credentials.retrieveOnce(createId);

    const { requestId } = await runNotify({ regenerate: true });

    expect(directory.resets).toHaveLength(1);
    expect((await stepNamed(requestId, 'regenerate-credential')).credential).toMatchObject({
      supersededRequestId: null,
    });
  });

  it('does not reset the password a second time on a redelivery', async () => {
    // A redelivery after the commit must not reset a password the operator may
    // already have retrieved and handed over.
    await createdAccount();
    const { requestId } = await runNotify({ regenerate: true });
    const step = await stepNamed(requestId, 'regenerate-credential');

    await staleLease(requestId, step.stepId);
    await executeStep(deps(), { requestId, stepId: step.stepId, attempt: 2 });

    expect(directory.resets).toHaveLength(1);
    expect((await stepOf(requestId, step.stepId)).status).toBe('skipped');
  });

  it('still sends the letter after regenerating', async () => {
    await createdAccount();
    const before = sender.sent.length;

    const { requestId } = await runNotify({ regenerate: true });

    expect(sender.sent.length).toBe(before + 1);
    expect((await stepNamed(requestId, 'send-welcome-letter')).status).toBe('succeeded');
  });

  it('puts no password in the letter it then sends', async () => {
    await createdAccount();

    await runNotify({ regenerate: true });
    const issued = directory.resets[0]!.password;

    expect(sender.sent.at(-1)!.body).not.toContain(issued);
  });
});

// ------------------------------------------------------------------- AC-5

describe('AC-5: the superseded ciphertext is unretrievable', () => {
  it('yields nothing for the request whose credential was replaced', async () => {
    // The state behind the 410. The status code itself is asserted against the
    // real route in the API service's credential suite; what has to be true
    // here is that the record can no longer produce a password.
    const createId = await createdAccount();

    await runNotify({ regenerate: true });

    expect(await credentials.retrieveOnce(createId)).toBeNull();
  });

  it('still yields the new password for the request that replaced it', async () => {
    // The positive control. A null from a broken store would satisfy the
    // assertion above on its own.
    await createdAccount();
    const { requestId } = await runNotify({ regenerate: true });

    expect(await credentials.retrieveOnce(requestId)).toEqual({
      primaryEmail: TARGET,
      password: directory.resets[0]!.password,
    });
  });

  it('points a resend that reused the credential at the original record', async () => {
    // Retrieval against the RESEND has to find the credential the create
    // request produced. Without the pointer the handoff document would still be
    // keyed by the create request and retrieval would find nothing.
    const createId = await createdAccount();
    const { requestId } = await runNotify();

    await expect(store.resolveCredentialRequestId(requestId)).resolves.toBe(createId);
  });

  it('resolves a create request to its own record, as it always did', async () => {
    const createId = await createdAccount();

    await expect(store.resolveCredentialRequestId(createId)).resolves.toBe(createId);
  });
});

// ------------------------------------------------------------------- AC-6

describe('AC-6: regeneration is audited as a credential rotation', () => {
  it('writes a rotation event naming the operator and the target user', async () => {
    await createdAccount();

    const { requestId } = await runNotify({ regenerate: true });
    const rotation = (await auditFor(requestId)).find((e) => e.action === 'credential.rotated');

    expect(rotation).toBeDefined();
    expect(rotation!.targetUser).toBe(TARGET);
    // The step runs as the system, on behalf of the operator who submitted it.
    // Recording only 'lifecycle-worker' would make the trail unable to answer
    // who reset a real person's password.
    expect(rotation!.actor.onBehalfOf).toBe(OPERATOR);
  });

  it('names the record superseded and the record that replaced it', async () => {
    const createId = await createdAccount();

    const { requestId } = await runNotify({ regenerate: true });
    const rotation = (await auditFor(requestId)).find((e) => e.action === 'credential.rotated')!;

    expect(rotation.before).toMatchObject({ credentialRequestId: createId });
    expect(rotation.after).toMatchObject({ credentialRequestId: requestId, rotated: true });
  });

  it('records neither the old password nor the new one, anywhere in the trail', async () => {
    const createId = await createdAccount();

    const { requestId } = await runNotify({ regenerate: true });
    const issued = directory.resets[0]!.password;

    // Every event for both requests, serialised whole. The audit trail is
    // readable by everyone entitled to read audit, and it outlives the TTL that
    // was supposed to retire the credential.
    const everything = JSON.stringify([...(await auditFor(requestId)), ...(await auditFor(createId))]);
    expect(everything).not.toContain(issued);
    expect(everything).not.toContain('original-one-time-password');
  });

  it('records no password on the step record either', async () => {
    await createdAccount();

    const { requestId } = await runNotify({ regenerate: true });
    const issued = directory.resets[0]!.password;

    // Step output is shown in the console and mirrored to logs.
    expect(JSON.stringify(await store.listSteps(requestId))).not.toContain(issued);
  });

  it('distinguishes a reuse from a rotation in the trail', async () => {
    await createdAccount();

    const { requestId } = await runNotify();
    const actions = (await auditFor(requestId)).map((e) => e.action);

    expect(actions).toContain('credential.confirmed');
    expect(actions).not.toContain('credential.rotated');
  });
});

// ------------------------------------------------------------------- AC-7

describe('AC-7: regeneration is subject to the approval policy', () => {
  const GATED: ApprovalPolicy = {
    ...DEFAULT_POLICY,
    notify: { 'regenerate-credential': { requiresApproval: true, approverRole: 'approver' } },
  };

  it('halts the regeneration step for approval instead of resetting the password', async () => {
    await createdAccount();

    const { requestId } = await runNotify({ regenerate: true }, GATED);

    expect((await stepNamed(requestId, 'regenerate-credential')).status).toBe('awaiting_approval');
    expect(directory.resets).toEqual([]);
  });

  it('sends no letter while the reset is waiting on an approver', async () => {
    await createdAccount();

    const { requestId } = await runNotify({ regenerate: true }, GATED);

    expect((await stepNamed(requestId, 'send-welcome-letter')).status).toBe('pending');
  });

  it('resets the password once an approver releases the step', async () => {
    await createdAccount();
    const { requestId } = await runNotify({ regenerate: true }, GATED);
    const step = await stepNamed(requestId, 'regenerate-credential');

    await store.decideStep({
      requestId,
      stepId: step.stepId,
      decision: 'approved',
      approver: { kind: 'human', email: 'approver@company.com' },
      justification: 'confirmed with the new hire by phone',
    });
    await executeStep(deps(), { requestId, stepId: step.stepId, attempt: 1 });

    expect(directory.resets).toHaveLength(1);
  });

  it('resets nothing when the approver rejects', async () => {
    await createdAccount();
    const { requestId } = await runNotify({ regenerate: true }, GATED);
    const step = await stepNamed(requestId, 'regenerate-credential');

    await store.decideStep({
      requestId,
      stepId: step.stepId,
      decision: 'rejected',
      approver: { kind: 'human', email: 'approver@company.com' },
      justification: 'could not reach the new hire to confirm',
    });

    expect(directory.resets).toEqual([]);
    expect((await store.getRequest(requestId))!.status).toBe('rejected');
  });

  it('leaves an ordinary resend ungated by the same policy', async () => {
    // The reason the two credential steps have different names. A tenant that
    // wants approval before a password reset must not have to put an approval in
    // front of every resend.
    await createdAccount();

    const { requestId } = await runNotify({ regenerate: false }, GATED);

    expect((await stepNamed(requestId, 'confirm-credential')).status).toBe('succeeded');
    expect((await stepNamed(requestId, 'send-welcome-letter')).status).toBe('succeeded');
  });
});

// ------------------------------------------------------------------- AC-8

describe('AC-8: a corrected address applies to the resend only', () => {
  it('sends the new letter to the corrected address', async () => {
    await createdAccount();
    await runNotify();

    const { requestId } = await runNotify({ notificationEmail: 'ada.corrected@example.com' });

    expect(sender.sent.at(-1)!.to).toEqual(['ada.corrected@example.com']);
    expect((await store.getRequest(requestId))!.payload.notificationEmail).toBe(
      'ada.corrected@example.com',
    );
  });

  it('leaves the original request record exactly as it was', async () => {
    await createdAccount();
    const first = await runNotify();
    const before = await store.getRequest(first.requestId);

    await runNotify({ notificationEmail: 'ada.corrected@example.com' });

    const after = await store.getRequest(first.requestId);
    expect(after!.payload.notificationEmail).toBe('ada.personal@example.com');
    // Not just the address: nothing about the original moved. A resend that
    // rewrote history would destroy the record of where the lost letter went,
    // which is the evidence someone is investigating in the first place.
    expect(after!.updatedAt.toMillis()).toBe(before!.updatedAt.toMillis());
  });

  it('keeps the original delivery record pointing at the address that was used', async () => {
    await createdAccount();
    const first = await runNotify();

    await runNotify({ notificationEmail: 'ada.corrected@example.com' });

    const original = await stepNamed(first.requestId, 'send-welcome-letter');
    expect(original.notification!.recipients).toEqual(['ada.personal@example.com']);
  });
});

// ------------------------------------------------------------------- AC-9

describe('AC-9: a resend for a deleted account fails in validation', () => {
  it('fails the validation step when the account is gone', async () => {
    await createdAccount();
    directory.exists = false;

    const { requestId, steps } = await runNotify();

    const validate = await stepOf(requestId, steps[0]!.stepId);
    expect(validate.status).toBe('failed');
    expect(validate.error!.message).toContain('does not exist');
  });

  it('resets no password and sends nothing', async () => {
    // "Before any Workspace call" read as it can be: the existence check is
    // itself a read against Workspace, and there is no other way to learn the
    // account is gone. What must not happen is any MUTATION, and no letter.
    await createdAccount();
    directory.exists = false;
    const before = sender.sent.length;

    await runNotify({ regenerate: true });

    expect(directory.resets).toEqual([]);
    expect(sender.sent.length).toBe(before);
  });

  it('never reaches the credential step at all', async () => {
    await createdAccount();
    directory.exists = false;

    const { requestId } = await runNotify({ regenerate: true });

    expect((await stepNamed(requestId, 'regenerate-credential')).status).toBe('pending');
  });

  it('leaves the stored credential untouched, so nothing is destroyed on a mistake', async () => {
    const createId = await createdAccount();
    directory.exists = false;

    await runNotify({ regenerate: true });

    const record = (await handoff(createId))!;
    expect(record.oneTimePasswordCiphertext).not.toBe('');
    expect(record.supersededAt ?? null).toBeNull();
  });

  it('fails the request rather than leaving it mid-flight', async () => {
    await createdAccount();
    directory.exists = false;

    const { requestId } = await runNotify();

    expect((await store.getRequest(requestId))!.status).toBe('failed');
  });
});
