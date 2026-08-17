import { Firestore, Timestamp } from '@google-cloud/firestore';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  LifecycleStore,
  buildNewRequest,
  stepPlanFor,
  type ApprovalPolicy,
  type AuditActor,
  type AuditEvent,
  type LifecycleStep,
} from '@lifecycle/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NoEligibleApproverError, notifyApprovers } from './approvers.js';
import { NotificationError, type DeliveryReceipt, type Message, type NotificationSender } from './sender.js';
import { advance } from '../steps/advance.js';
import { executeStep } from '../steps/executor.js';
import '../phases/notify.js';
import { useNotificationSender } from '../phases/notify.js';

/**
 * TC-REQ-004-2, 3, 5, 6 and TC-REQ-032-1, 2, 3, 4, 7, 8, 10.
 *
 * Against the emulator because every claim here is about what is DURABLE: a
 * delivery id that survives a crash between the send and the step settling, a
 * suppression that survives a redelivery, a failure that leaves the request
 * untouched. The sender is the only substitute, and it records rather than
 * sends so the assertions are about what would have gone out.
 */

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
}

const db = new Firestore({ projectId: 'demo-lifecycle' });
const store = new LifecycleStore(db);

const ACTOR: AuditActor = { kind: 'human', email: 'operator@company.com' };
const CONSOLE = 'https://console.company.com';

const NOTIFY_PAYLOAD = {
  primaryEmail: 'ada.lovelace@company.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  notificationEmail: 'ada.personal@example.com',
};

class RecordingSender implements NotificationSender {
  sent: Message[] = [];
  failWith: NotificationError | undefined;
  private next = 0;

  async send(message: Message): Promise<DeliveryReceipt> {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = undefined;
      throw err;
    }
    this.sent.push(message);
    this.next += 1;
    return { deliveryId: `delivery-${this.next}`, bounceReportingAvailable: false };
  }
}

let sender: RecordingSender;

/** advance() needs a dispatcher; nothing here asserts on enqueues. */
const silentDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

/** The directory stub the notify phase reads before sending. */
function directoryWith(exists: boolean) {
  return { async getUser() { return exists ? { primaryEmail: NOTIFY_PAYLOAD.primaryEmail } : null; } };
}

function deps(overrides: { exists?: boolean } = {}) {
  return {
    store,
    directory: directoryWith(overrides.exists ?? true) as never,
    credentials: {} as never,
    advance: async () => {},
  };
}

async function notifyRequest(payload = NOTIFY_PAYLOAD) {
  const documents = buildNewRequest({
    phase: 'notify',
    targetUser: payload.primaryEmail,
    requestedBy: 'operator@company.com',
    payload,
    plan: stepPlanFor('notify', payload),
    policy: DEFAULT_POLICY,
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);
  return { requestId: documents.request.requestId, steps: documents.steps };
}

/** Drives the notify request to the point where the send step is claimable. */
async function readyToSend(payload = NOTIFY_PAYLOAD) {
  const { requestId, steps } = await notifyRequest(payload);
  await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });
  await store.transitionStep({
    requestId,
    stepId: steps[1]!.stepId,
    expectedFrom: 'pending',
    to: 'ready',
    audit: { actor: ACTOR, action: 'step.ready' },
  });
  return { requestId, sendStepId: steps[1]!.stepId, steps };
}

/** A create request halted on its first step, for the approver notice. */
async function halted(policy?: ApprovalPolicy) {
  const payload = { primaryEmail: 'grace.hopper@company.com', givenName: 'Grace', familyName: 'Hopper', groups: [] };
  const documents = buildNewRequest({
    phase: 'create',
    targetUser: payload.primaryEmail,
    requestedBy: 'operator@company.com',
    payload,
    plan: stepPlanFor('create', payload),
    policy: policy ?? {
      ...DEFAULT_POLICY,
      create: { 'validate-request': { requiresApproval: true, approverRole: 'approver' } },
    },
  });
  await store.createRequest(documents, ACTOR);
  await store.startFirstStep(documents.request.requestId, ACTOR);
  return { requestId: documents.request.requestId, stepId: documents.steps[0]!.stepId };
}

async function stepOf(requestId: string, stepId: string): Promise<LifecycleStep> {
  return (await store.listSteps(requestId)).find((s) => s.stepId === stepId)!;
}

async function auditOf(requestId: string): Promise<AuditEvent[]> {
  return store.listAudit(requestId);
}

async function wipe() {
  for (const collection of [COLLECTIONS.requests, COLLECTIONS.audit, COLLECTIONS.roleBindings]) {
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
  sender = new RecordingSender();
  useNotificationSender(sender);
  await wipe();
});

sender = new RecordingSender();
useNotificationSender(sender);

describe('REQ-004 AC-2: the letter goes out of band, never to the new mailbox', () => {
  it('delivers to the notification address on the request', async () => {
    const { requestId, sendStepId } = await readyToSend();

    await executeStep(deps(), { requestId, stepId: sendStepId, attempt: 1 });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toEqual(['ada.personal@example.com']);
    // The new mailbox cannot be read until the sign-in the letter explains.
    expect(sender.sent[0]!.to).not.toContain(NOTIFY_PAYLOAD.primaryEmail);
  });

  it('refuses before sending when the notification address is the new mailbox', async () => {
    const { requestId, steps } = await notifyRequest({
      ...NOTIFY_PAYLOAD,
      notificationEmail: NOTIFY_PAYLOAD.primaryEmail,
    });

    const outcome = await executeStep(deps(), { requestId, stepId: steps[0]!.stepId, attempt: 1 });

    expect(outcome).toEqual({ kind: 'settled', status: 'failed' });
    expect(sender.sent).toHaveLength(0);
  });

  it('refuses before sending when the account does not exist', async () => {
    const { requestId, steps } = await notifyRequest();

    const outcome = await executeStep(deps({ exists: false }), {
      requestId,
      stepId: steps[0]!.stepId,
      attempt: 1,
    });

    expect(outcome).toEqual({ kind: 'settled', status: 'failed' });
    expect(sender.sent).toHaveLength(0);
  });
});

describe('REQ-004 AC-3: retrying never sends a second letter', () => {
  it('short-circuits on the recorded delivery id', async () => {
    const { requestId, sendStepId } = await readyToSend();
    await executeStep(deps(), { requestId, stepId: sendStepId, attempt: 1 });

    // The crash case: the send landed and the record was written, but the step
    // never settled. The lease expires and the step is replayed.
    await db
      .collection(COLLECTIONS.requests).doc(requestId)
      .collection(COLLECTIONS.steps).doc(sendStepId)
      .update({ status: 'running', startedAt: Timestamp.fromMillis(Date.now() - 3_600_000) });

    const replay = await executeStep(deps({ }), { requestId, stepId: sendStepId, attempt: 2 });

    expect(replay).toEqual({ kind: 'settled', status: 'skipped' });
    expect(sender.sent).toHaveLength(1);
  });

  it('records the delivery id durably at send time, not on settle', async () => {
    const { requestId, sendStepId } = await readyToSend();

    await executeStep(deps(), { requestId, stepId: sendStepId, attempt: 1 });

    const step = await stepOf(requestId, sendStepId);
    expect(step.notification).toMatchObject({ deliveryId: 'delivery-1', error: null });
    expect(step.notification!.recipients).toEqual(['ada.personal@example.com']);
  });
});

describe('REQ-004 AC-5 and AC-6: a refused submission is recorded, not swallowed', () => {
  it('records the provider error on the step and fails the step', async () => {
    const { requestId, sendStepId } = await readyToSend();
    sender.failWith = new NotificationError('SMTP 550: mailbox unavailable', false);

    const outcome = await executeStep(deps(), { requestId, stepId: sendStepId, attempt: 1 });

    expect(outcome).toEqual({ kind: 'settled', status: 'failed' });
    const step = await stepOf(requestId, sendStepId);
    expect(step.notification).toMatchObject({ deliveryId: null });
    expect(step.notification!.error).toContain('550');
  });

  it('leaves the request resumable rather than silently succeeding', async () => {
    const { requestId, sendStepId } = await readyToSend();
    sender.failWith = new NotificationError('SMTP 550: mailbox unavailable', false);
    await executeStep(deps(), { requestId, stepId: sendStepId, attempt: 1 });

    // Failed, so an admin can resume it once the address is corrected. A silent
    // success would mean nobody ever learns the new hire was not told.
    expect((await store.getRequest(requestId))!.status).toBe('failed');
    const resumed = await store.resumeRequest({ requestId, actor: ACTOR });
    expect(resumed.resumed).toBe(true);
  });

  it('retries a transient refusal instead of failing the request', async () => {
    const { requestId, sendStepId } = await readyToSend();
    sender.failWith = new NotificationError('SMTP 451: try again later', true);

    const outcome = await executeStep(deps({ }), { requestId, stepId: sendStepId, attempt: 1 });

    expect(outcome.kind).toBe('retry');
    expect((await store.getRequest(requestId))!.status).toBe('running');
  });

  it('records that the provider cannot report bounces, rather than implying it can', async () => {
    const { requestId, sendStepId } = await readyToSend();

    await executeStep(deps(), { requestId, stepId: sendStepId, attempt: 1 });

    const step = await stepOf(requestId, sendStepId);
    // With the Workspace relay 'sent' means 'accepted', nothing more. Saying so
    // is the honest reading of the only channel reaching a new hire.
    expect(step.output).toMatchObject({ bounceReportingAvailable: false, deliveryId: 'delivery-1' });
  });
});

describe('REQ-032 AC-1 to AC-3: who is told, and who is not', () => {
  async function bind(subject: string, roles: ('requester' | 'approver' | 'admin')[]) {
    await store.setRoleBinding({ subject, kind: 'user', roles, actor: ACTOR });
  }

  it('sends exactly one notification to the eligible approvers', async () => {
    const { requestId, stepId } = await halted();
    await bind('alice@company.com', ['approver']);
    await bind('bob@company.com', ['approver']);

    const outcome = await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    expect(outcome.sent).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toEqual(['alice@company.com', 'bob@company.com']);
  });

  it('never notifies the requester about their own request', async () => {
    const { requestId, stepId } = await halted();
    // The requester holds the approver role too, and still must not be asked:
    // REQ-002 forbids self-approval, so mailing them invites a refusal.
    await bind('operator@company.com', ['requester', 'approver']);
    await bind('alice@company.com', ['approver']);

    await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    expect(sender.sent[0]!.to).toEqual(['alice@company.com']);
  });

  it('notifies for a LATER step halted by the worker, not only the first halted by the API', async () => {
    // AC-1 names both halting services. The first step is halted by the API at
    // admission; every later one is halted by advance() in the worker, and the
    // notice has to work identically from either.
    const payload = { primaryEmail: 'grace.hopper@company.com', givenName: 'Grace', familyName: 'Hopper', groups: [] };
    const documents = buildNewRequest({
      phase: 'create',
      targetUser: payload.primaryEmail,
      requestedBy: 'operator@company.com',
      payload,
      plan: stepPlanFor('create', payload),
      policy: { ...DEFAULT_POLICY, create: { 'create-user': { requiresApproval: true, approverRole: 'approver' } } },
    });
    await store.createRequest(documents, ACTOR);
    await store.startFirstStep(documents.request.requestId, ACTOR);
    const requestId = documents.request.requestId;
    const first = documents.steps[0]!;
    const second = documents.steps[1]!;

    // Finish the first step, then let the worker advance onto the second, which
    // its policy halts.
    await store.transitionStep({ requestId, stepId: first.stepId, expectedFrom: 'ready', to: 'running', audit: { actor: ACTOR, action: 'step.running' } });
    await store.transitionStep({ requestId, stepId: first.stepId, expectedFrom: 'running', to: 'succeeded', audit: { actor: ACTOR, action: 'step.succeeded' } });
    await advance({ store, dispatcher: silentDispatcher }, requestId, first.stepId);

    expect((await stepOf(requestId, second.stepId)).status).toBe('awaiting_approval');

    await bind('alice@company.com', ['approver']);
    const outcome = await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId: second.stepId });

    expect(outcome.sent).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toEqual(['alice@company.com']);
  });

  it('excludes identities without the role the snapshot requires', async () => {
    const { requestId, stepId } = await halted();
    await bind('alice@company.com', ['approver']);
    await bind('carol@company.com', ['requester']);

    await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    expect(sender.sent[0]!.to).toEqual(['alice@company.com']);
  });

  it('resolves against the SNAPSHOT, so a later policy edit does not change who is asked', async () => {
    // Halted under a policy requiring 'approver'.
    const { requestId, stepId } = await halted();
    await bind('alice@company.com', ['approver']);
    await bind('root@company.com', ['admin']);

    // The live policy now demands 'admin' for this step. The in-flight request
    // must be unaffected: it carries the policy it was created under.
    await store.setApprovalPolicy({
      policy: {
        ...DEFAULT_POLICY,
        create: { 'validate-request': { requiresApproval: true, approverRole: 'admin' } },
      },
      actor: ACTOR,
    });

    await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    expect(sender.sent[0]!.to).toEqual(['alice@company.com']);
  });

  it('mails a group binding at its group address', async () => {
    const { requestId, stepId } = await halted();
    await store.setRoleBinding({
      subject: 'approvers@company.com',
      kind: 'group',
      roles: ['approver'],
      actor: ACTOR,
    });

    await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    expect(sender.sent[0]!.to).toEqual(['approvers@company.com']);
  });
});

describe('REQ-032 AC-4: a redelivery does not send a second message', () => {
  it('short-circuits on the recorded delivery id', async () => {
    const { requestId, stepId } = await halted();
    await store.setRoleBinding({ subject: 'alice@company.com', kind: 'user', roles: ['approver'], actor: ACTOR });

    await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });
    const again = await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    expect(sender.sent).toHaveLength(1);
    expect(again.sent).toBe(false);
    expect(again.deliveryId).toBe('delivery-1');
  });

  it('suppresses the notice when the step has already been decided', async () => {
    const { requestId, stepId } = await halted();
    await store.setRoleBinding({ subject: 'alice@company.com', kind: 'user', roles: ['approver'], actor: ACTOR });

    await store.decideStep({
      requestId,
      stepId,
      decision: 'approved',
      approver: { kind: 'human', email: 'alice@company.com' },
      justification: 'already handled',
    });

    const outcome = await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    // Asking for a decision that has been made is worse than saying nothing.
    expect(outcome.sent).toBe(false);
    expect(sender.sent).toHaveLength(0);
    const suppressed = (await auditOf(requestId)).find((e) => e.action === 'notification.suppressed');
    expect(suppressed).toBeTruthy();
  });
});

describe('REQ-032 AC-7: nobody eligible fails loudly', () => {
  it('raises NoEligibleApprover rather than reporting a send to nobody', async () => {
    const { requestId, stepId } = await halted();

    await expect(
      notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId }),
    ).rejects.toBeInstanceOf(NoEligibleApproverError);

    expect(sender.sent).toHaveLength(0);
  });

  it('records the condition on the step so an admin can see it', async () => {
    const { requestId, stepId } = await halted();

    await expect(
      notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId }),
    ).rejects.toThrow();

    const step = await stepOf(requestId, stepId);
    expect(step.approverNotification!.error).toContain("'approver'");
    const event = (await auditOf(requestId)).find((e) => e.action === 'notification.no_eligible_approver');
    expect(event).toBeTruthy();
  });

  it('leaves the request awaiting approval, not failed', async () => {
    const { requestId, stepId } = await halted();

    await expect(
      notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId }),
    ).rejects.toThrow();

    expect((await store.getRequest(requestId))!.status).toBe('awaiting_approval');
  });
});

describe('REQ-032 AC-8: a delivery failure never fails the request', () => {
  it('records the failure and rethrows for retry, leaving the request awaiting approval', async () => {
    const { requestId, stepId } = await halted();
    await store.setRoleBinding({ subject: 'alice@company.com', kind: 'user', roles: ['approver'], actor: ACTOR });
    sender.failWith = new NotificationError('SMTP 451: greylisted', true);

    await expect(
      notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId }),
    ).rejects.toBeInstanceOf(NotificationError);

    // The approval is still pending; only the telling failed.
    expect((await store.getRequest(requestId))!.status).toBe('awaiting_approval');
    expect((await stepOf(requestId, stepId)).status).toBe('awaiting_approval');

    const step = await stepOf(requestId, stepId);
    expect(step.approverNotification!.error).toContain('451');
    expect(step.approverNotification!.deliveryId).toBeNull();
  });

  it('sends on the retry that follows a failure', async () => {
    const { requestId, stepId } = await halted();
    await store.setRoleBinding({ subject: 'alice@company.com', kind: 'user', roles: ['approver'], actor: ACTOR });
    sender.failWith = new NotificationError('SMTP 451: greylisted', true);
    await expect(
      notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId }),
    ).rejects.toThrow();

    const outcome = await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    expect(outcome.sent).toBe(true);
    expect(sender.sent).toHaveLength(1);
  });
});

describe('REQ-032 AC-10: every send, failure and suppression is audited', () => {
  it('names the step and the recipients on a successful send', async () => {
    const { requestId, stepId } = await halted();
    await store.setRoleBinding({ subject: 'alice@company.com', kind: 'user', roles: ['approver'], actor: ACTOR });

    await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    const event = (await auditOf(requestId)).find((e) => e.action === 'notification.sent')!;
    expect(event.stepId).toBe(stepId);
    expect(event.after).toMatchObject({ recipients: ['alice@company.com'], deliveryId: 'delivery-1' });
    expect(event.outcome).toBe('success');
  });

  it('records a failure with outcome failure', async () => {
    const { requestId, stepId } = await halted();
    await store.setRoleBinding({ subject: 'alice@company.com', kind: 'user', roles: ['approver'], actor: ACTOR });
    sender.failWith = new NotificationError('SMTP 451: greylisted', true);

    await expect(
      notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId }),
    ).rejects.toThrow();

    const event = (await auditOf(requestId)).find((e) => e.action === 'notification.failed')!;
    expect(event.outcome).toBe('failure');
    expect(event.stepId).toBe(stepId);
  });

  it('never puts the message body in the audit trail', async () => {
    const { requestId, stepId } = await halted();
    await store.setRoleBinding({ subject: 'alice@company.com', kind: 'user', roles: ['approver'], actor: ACTOR });

    await notifyApprovers({ store, sender, consoleBaseUrl: CONSOLE }, { requestId, stepId });

    const event = (await auditOf(requestId)).find((e) => e.action === 'notification.sent')!;
    // Addresses are recorded; content is not. A template could carry anything.
    expect(JSON.stringify(event.after)).not.toContain('Approval needed');
  });
});
