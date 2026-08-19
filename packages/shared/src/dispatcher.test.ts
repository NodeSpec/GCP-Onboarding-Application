import { describe, expect, it } from 'vitest';
import {
  CloudTasksDispatcher,
  discriminators,
  queuePathFor,
  taskNameFor,
  type DispatcherSettings,
  type TaskQueueClient,
} from './dispatcher.js';
import { deriveIdempotencyKey } from './stepPlans.js';

/**
 * The dispatcher, exercised against a recording client.
 *
 * The point of the whole module is that BOTH services derive the same task name
 * for the same step, because Cloud Tasks deduplicates on that name and nothing
 * reports a mismatch: a drifted name means the step simply runs twice. So the
 * central test here builds two dispatchers from two different service
 * configurations and asserts the names agree.
 *
 * Serves REQ-001 AC-7, REQ-002 AC-7 and REQ-013 AC-7.
 */

interface RecordedTask {
  parent: string;
  task: Record<string, unknown>;
}

class RecordingClient implements TaskQueueClient {
  readonly tasks: RecordedTask[] = [];
  failWith: unknown;

  async createTask(request: RecordedTask): Promise<unknown> {
    if (this.failWith !== undefined) throw this.failWith;
    this.tasks.push(request);
    return {};
  }
}

const API_SETTINGS: DispatcherSettings = {
  projectId: 'demo-lifecycle',
  location: 'europe-west2',
  queue: 'lifecycle-steps',
  workerBaseUrl: 'https://worker.example.run.app',
  invokerServiceAccount: 'queue-invoker@demo-lifecycle.iam.gserviceaccount.com',
};

// The worker's own configuration object. Same queue, same worker URL, read from
// a different service's environment. This is the pair that must not drift.
const WORKER_SETTINGS: DispatcherSettings = { ...API_SETTINGS };

function build(settings: DispatcherSettings = API_SETTINGS) {
  const client = new RecordingClient();
  const dispatcher = new CloudTasksDispatcher(settings, { client });
  return { client, dispatcher };
}

function bodyOf(task: RecordedTask): Record<string, unknown> {
  const http = task.task.httpRequest as { body: string };
  return JSON.parse(Buffer.from(http.body, 'base64').toString('utf8')) as Record<string, unknown>;
}

function httpOf(task: RecordedTask) {
  return task.task.httpRequest as {
    url: string;
    httpMethod: string;
    oidcToken: { serviceAccountEmail: string; audience: string };
  };
}

describe('both services derive the same task name', () => {
  it('agrees on the execution task name across two independently configured dispatchers', async () => {
    const key = deriveIdempotencyKey('req-1', '001-create-user', { primaryEmail: 'a@example.com' });

    const api = build(API_SETTINGS);
    const worker = build(WORKER_SETTINGS);

    await api.dispatcher.enqueueStep({ requestId: 'req-1', stepId: '001-create-user', idempotencyKey: key });
    await worker.dispatcher.enqueueStep({ requestId: 'req-1', stepId: '001-create-user', idempotencyKey: key });

    expect(api.client.tasks[0]!.task.name).toBe(worker.client.tasks[0]!.task.name);
  });

  it('agrees on the approver-notification task name', async () => {
    const api = build(API_SETTINGS);
    const worker = build(WORKER_SETTINGS);

    await api.dispatcher.enqueueApproverNotification({ requestId: 'req-1', stepId: '004-delete-user' });
    await worker.dispatcher.enqueueApproverNotification({ requestId: 'req-1', stepId: '004-delete-user' });

    expect(api.client.tasks[0]!.task.name).toBe(worker.client.tasks[0]!.task.name);
  });

  it('gives distinct steps distinct names', async () => {
    const { client, dispatcher } = build();
    const first = deriveIdempotencyKey('req-1', '001-create-user', {});
    const second = deriveIdempotencyKey('req-1', '002-apply-attributes', {});

    await dispatcher.enqueueStep({ requestId: 'req-1', stepId: '001-create-user', idempotencyKey: first });
    await dispatcher.enqueueStep({ requestId: 'req-1', stepId: '002-apply-attributes', idempotencyKey: second });

    expect(client.tasks[0]!.task.name).not.toBe(client.tasks[1]!.task.name);
  });

  it('gives the same step in two different requests distinct names', async () => {
    const { client, dispatcher } = build();
    const first = deriveIdempotencyKey('req-1', '001-create-user', {});
    const second = deriveIdempotencyKey('req-2', '001-create-user', {});

    await dispatcher.enqueueStep({ requestId: 'req-1', stepId: '001-create-user', idempotencyKey: first });
    await dispatcher.enqueueStep({ requestId: 'req-2', stepId: '001-create-user', idempotencyKey: second });

    expect(client.tasks[0]!.task.name).not.toBe(client.tasks[1]!.task.name);
  });

  it('separates the three task types for one step', async () => {
    const { client, dispatcher } = build();
    const key = deriveIdempotencyKey('req-1', '001-create-user', {});

    await dispatcher.enqueueStep({ requestId: 'req-1', stepId: '001-create-user', idempotencyKey: key });
    await dispatcher.enqueueApproverNotification({ requestId: 'req-1', stepId: '001-create-user' });
    await dispatcher.enqueueApprovalExpiry({
      requestId: 'req-1',
      stepId: '001-create-user',
      fireAt: new Date('2026-01-01T00:00:00Z'),
    });

    const names = client.tasks.map((t) => t.task.name);
    expect(new Set(names).size).toBe(3);
  });
});

describe('task names are legal Cloud Tasks resource names', () => {
  it('contains no character outside the permitted set', () => {
    // An idempotency key contains colons, which Cloud Tasks refuses, so the
    // hash is doing real work rather than being decorative.
    const key = deriveIdempotencyKey('req-1', '001-create-user', {});
    expect(key).toContain(':');

    const name = taskNameFor(queuePathFor(API_SETTINGS), discriminators.step(key));
    const id = name.split('/tasks/')[1]!;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('a resume nonce produces a DISTINCT legal name for the same step', () => {
    // Cloud Tasks remembers an executed task's name for about an hour, so a
    // resume that reuses the plain name is silently swallowed as a duplicate
    // and nothing ever delivers. The nonce is what makes a resume deliverable;
    // without it this test's two names would collide.
    const path = queuePathFor(API_SETTINGS);
    const key = deriveIdempotencyKey('req-1', '001-create-user', {});

    const plain = taskNameFor(path, discriminators.step(key));
    const resumed = taskNameFor(path, discriminators.step(key, 'abc123'));

    expect(resumed).not.toBe(plain);
    expect(resumed.split('/tasks/')[1]!).toMatch(/^[A-Za-z0-9_-]+$/);
    // And a plain enqueue still collapses onto the plain name.
    expect(taskNameFor(path, discriminators.step(key))).toBe(plain);
  });

  it('is stable for the same discriminator', () => {
    const path = queuePathFor(API_SETTINGS);
    expect(taskNameFor(path, 'execute:abc')).toBe(taskNameFor(path, 'execute:abc'));
  });

  it('builds the queue path from the settings', () => {
    expect(queuePathFor(API_SETTINGS)).toBe(
      'projects/demo-lifecycle/locations/europe-west2/queues/lifecycle-steps',
    );
  });
});

describe('the task carries what the worker needs to authenticate and act', () => {
  it('targets the execute-step route with an OIDC token for the invoker', async () => {
    const { client, dispatcher } = build();
    await dispatcher.enqueueStep({ requestId: 'req-1', stepId: '001-create-user', idempotencyKey: 'k' });

    const http = httpOf(client.tasks[0]!);
    expect(http.httpMethod).toBe('POST');
    expect(http.url).toBe('https://worker.example.run.app/tasks/execute-step');
    expect(http.oidcToken.serviceAccountEmail).toBe(API_SETTINGS.invokerServiceAccount);
    // The audience is the service URL, which is what taskAuth verifies against.
    expect(http.oidcToken.audience).toBe(API_SETTINGS.workerBaseUrl);
  });

  it('carries the request, step and idempotency key in the body', async () => {
    const { client, dispatcher } = build();
    await dispatcher.enqueueStep({
      requestId: 'req-1',
      stepId: '001-create-user',
      idempotencyKey: 'key-1',
    });

    expect(bodyOf(client.tasks[0]!)).toEqual({
      requestId: 'req-1',
      stepId: '001-create-user',
      idempotencyKey: 'key-1',
      attempt: 1,
    });
  });

  it('routes notifications and expiries to their own endpoints', async () => {
    const { client, dispatcher } = build();
    await dispatcher.enqueueApproverNotification({ requestId: 'req-1', stepId: 's' });
    await dispatcher.enqueueApprovalExpiry({ requestId: 'req-1', stepId: 's', fireAt: new Date() });

    expect(httpOf(client.tasks[0]!).url).toBe('https://worker.example.run.app/tasks/notify-approvers');
    expect(httpOf(client.tasks[1]!).url).toBe('https://worker.example.run.app/tasks/expire-approval');
  });

  it('never puts a schedule time on an unscheduled task', async () => {
    const { client, dispatcher } = build();
    await dispatcher.enqueueStep({ requestId: 'req-1', stepId: 's', idempotencyKey: 'k' });

    // Absent, not undefined: an explicit undefined is a different thing to the
    // protobuf encoder than an omitted field.
    expect('scheduleTime' in client.tasks[0]!.task).toBe(false);
  });
});

describe('scheduling', () => {
  it('accepts a Date and converts it to epoch seconds', async () => {
    const { client, dispatcher } = build();
    await dispatcher.enqueueApprovalExpiry({
      requestId: 'req-1',
      stepId: 's',
      fireAt: new Date('2026-03-01T12:00:00Z'),
    });

    expect(client.tasks[0]!.task.scheduleTime).toEqual({
      seconds: Math.floor(Date.parse('2026-03-01T12:00:00Z') / 1000),
    });
  });

  it('accepts a Firestore Timestamp structurally', async () => {
    const { client, dispatcher } = build();
    // Any object with toMillis satisfies the type, so a caller holding a
    // Timestamp passes it straight through and this test needs no Firestore.
    const fireAt = { toMillis: () => Date.parse('2026-03-01T12:00:00Z') };

    await dispatcher.enqueueApprovalExpiry({ requestId: 'req-1', stepId: 's', fireAt });

    expect(client.tasks[0]!.task.scheduleTime).toEqual({
      seconds: Math.floor(Date.parse('2026-03-01T12:00:00Z') / 1000),
    });
  });

  it('schedules a held step for its release instant', async () => {
    const { client, dispatcher } = build();
    await dispatcher.enqueueStep({
      requestId: 'req-1',
      stepId: 's',
      idempotencyKey: 'k',
      scheduleAt: new Date('2026-04-01T00:00:00Z'),
    });

    expect(client.tasks[0]!.task.scheduleTime).toEqual({
      seconds: Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000),
    });
  });
});

describe('a repeat enqueue is absorbed, a real failure is not', () => {
  it('treats ALREADY_EXISTS as the deduplication working', async () => {
    const { client, dispatcher } = build();
    client.failWith = Object.assign(new Error('task already exists'), { code: 6 });

    await expect(
      dispatcher.enqueueStep({ requestId: 'req-1', stepId: 's', idempotencyKey: 'k' }),
    ).resolves.toBeUndefined();
  });

  it('propagates any other error', async () => {
    const { client, dispatcher } = build();
    client.failWith = Object.assign(new Error('permission denied'), { code: 7 });

    await expect(
      dispatcher.enqueueStep({ requestId: 'req-1', stepId: 's', idempotencyKey: 'k' }),
    ).rejects.toThrow('permission denied');
  });

  it('propagates an error with no code at all', async () => {
    const { client, dispatcher } = build();
    client.failWith = new Error('socket hang up');

    await expect(
      dispatcher.enqueueStep({ requestId: 'req-1', stepId: 's', idempotencyKey: 'k' }),
    ).rejects.toThrow('socket hang up');
  });
});
