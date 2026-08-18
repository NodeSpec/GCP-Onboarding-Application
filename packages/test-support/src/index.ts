import { Firestore } from '@google-cloud/firestore';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  COLLECTIONS,
  type EnqueueStepInput,
  type KeyProvider,
  type TaskDispatcher,
} from '@lifecycle/shared';

/**
 * Fixtures shared by every suite that talks to the Firestore emulator.
 *
 * This existed in nineteen copies before it lived here. That was not merely
 * repetitive: each copy carried its own list of collections to clear, and
 * several listed fewer than the suite actually wrote, so state leaked from one
 * test into the next and the leak was invisible until an unrelated assertion
 * failed. Clearing is now exhaustive by construction (see `wipeAll`).
 *
 * TEST-ONLY. Nothing in services/ or the other packages imports this, and it is
 * a devDependency everywhere it is used, so it cannot reach a deployed image.
 */

/** The emulator project id every suite shares. */
export const TEST_PROJECT_ID = 'demo-lifecycle';

/**
 * A Firestore client pointed at the emulator, refusing to run without one.
 *
 * The guard matters more than it looks: FIRESTORE_EMULATOR_HOST is what keeps
 * the client off a real project, and a suite that ran without it would create
 * and delete documents somewhere real while appearing to pass.
 */
export function emulatorDb(): Firestore {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via npm run test:emulator');
  }
  return new Firestore({ projectId: TEST_PROJECT_ID });
}

/**
 * Every top-level collection the application writes. Derived from COLLECTIONS
 * rather than listed by hand, minus `steps`, which is a subcollection of a
 * request and is cleared with its parent.
 *
 * Deriving it is the point: a new collection added to the model is cleared by
 * every suite automatically, instead of being forgotten in nineteen places.
 */
export const WIPEABLE_COLLECTIONS: readonly string[] = Object.entries(COLLECTIONS)
  .filter(([key]) => key !== 'steps')
  .map(([, value]) => value);

/**
 * Clears every collection, including each request's steps subcollection.
 *
 * Exhaustive on purpose. Callers used to pass the collections they believed
 * they touched, which is a judgement no test should have to make correctly:
 * the cost of clearing an already-empty collection against the emulator is a
 * round trip, and the cost of missing one is a test that passes or fails
 * depending on what ran before it.
 */
export async function wipeAll(db: Firestore): Promise<void> {
  for (const collection of WIPEABLE_COLLECTIONS) {
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

/**
 * A dispatcher that accepts everything and enqueues nothing.
 *
 * For suites whose subject is the state machine rather than the queue. A suite
 * that needs to assert on what WAS enqueued should use `recordingDispatcher`
 * instead, so the distinction stays visible in the test rather than hidden in
 * a shared stub.
 */
export const silentDispatcher: TaskDispatcher = {
  async enqueueStep() {},
  async enqueueApproverNotification() {},
  async enqueueApprovalExpiry() {},
};

export interface RecordingDispatcher extends TaskDispatcher {
  readonly steps: EnqueueStepInput[];
  readonly notifications: { requestId: string; stepId: string }[];
  readonly expiries: { requestId: string; stepId: string }[];
  /** Makes the next enqueueStep throw, for the deferred-dispatch paths. */
  failNextStep(): void;
  reset(): void;
}

/** A dispatcher that records what it was asked to enqueue. */
export function recordingDispatcher(): RecordingDispatcher {
  let failNext = false;
  const steps: EnqueueStepInput[] = [];
  const notifications: { requestId: string; stepId: string }[] = [];
  const expiries: { requestId: string; stepId: string }[] = [];

  return {
    steps,
    notifications,
    expiries,
    failNextStep() {
      failNext = true;
    },
    reset() {
      failNext = false;
      steps.length = 0;
      notifications.length = 0;
      expiries.length = 0;
    },
    async enqueueStep(input) {
      if (failNext) {
        failNext = false;
        throw new Error('cloud tasks unavailable');
      }
      steps.push(input);
    },
    async enqueueApproverNotification(input) {
      notifications.push(input);
    },
    async enqueueApprovalExpiry(input) {
      expiries.push({ requestId: input.requestId, stepId: input.stepId });
    },
  };
}

/**
 * An in-memory key provider holding one random 32-byte key.
 *
 * Real bytes rather than a fixed fixture, so a suite cannot accidentally pass
 * by matching a hardcoded key, and the same key answers both resolve paths so
 * ciphertext written in a test decrypts in that test.
 */
export function inMemoryKeys(version = 'versions/1'): KeyProvider {
  const key = randomBytes(32);
  return {
    resolve: async () => ({ key, version }),
    resolveVersion: async () => ({ key, version }),
  };
}

export interface TestServer {
  /** Base URL, e.g. http://127.0.0.1:53211 */
  base: string;
  close(): Promise<void>;
}

/**
 * Starts an express app on an ephemeral port and returns its base URL.
 *
 * Port 0 rather than a fixed one: suites run in parallel workers, and a fixed
 * port makes them collide in a way that looks like a flaky test.
 */
export async function startTestServer(app: {
  listen(port: number, host: string, cb: () => void): Server;
}): Promise<TestServer> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
