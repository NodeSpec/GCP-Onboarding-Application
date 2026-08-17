import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { requireCaller, type CallerClaims, type TokenVerifier } from './taskAuth.js';

/**
 * TC-REQ-016-8: route-class confinement on the worker.
 *
 * The worker is mounted here the way index.ts mounts it, on a real listening
 * server, because the criterion is about which routes an identity can reach and
 * that is a property of the mounting, not of the middleware in isolation. A
 * middleware-only test would still pass if someone mounted the gate after the
 * router.
 *
 * Only the token verifier is substituted. Google's signing key is not
 * obtainable, so the real verifier could only be exercised against the live
 * network. The fake reproduces the two decisions the real one makes, signature
 * validity and audience match, and every identity decision after that is made
 * by the production code path.
 */

const AUDIENCE = 'https://lifecycle-worker-abc123-uc.a.run.app';
const QUEUE_SA = 'lifecycle-queue-invoker@company-project.iam.gserviceaccount.com';
const API_SA = 'lifecycle-api@company-project.iam.gserviceaccount.com';
const OTHER_SA = 'some-other-service@company-project.iam.gserviceaccount.com';

/** Stands in for a Google-minted OIDC token. */
function token(claims: CallerClaims & { aud?: string; signature?: 'valid' | 'bad' }): string {
  return Buffer.from(JSON.stringify({ signature: 'valid', aud: AUDIENCE, ...claims })).toString('base64url');
}

const fakeVerifier: TokenVerifier = async (idToken, audience) => {
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(idToken, 'base64url').toString('utf8'));
  } catch {
    const err = new Error('token is not parseable');
    err.name = 'JWSInvalid';
    throw err;
  }
  if (decoded.signature !== 'valid') {
    const err = new Error('signature check failed');
    err.name = 'JWSSignatureVerificationFailed';
    throw err;
  }
  if (decoded.aud !== audience) {
    const err = new Error('audience mismatch');
    err.name = 'JWTClaimValidationFailed';
    throw err;
  }
  return decoded as CallerClaims;
};

function capturingLogger() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: pino({ level: 'warn' }, sink), lines };
}

const captured = capturingLogger();
const executeStep = vi.fn();
const lookupUsers = vi.fn();

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Mounted ahead of every gate, exactly as in the worker entry point.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const tasks = express.Router();
  tasks.post('/execute-step', (req, res) => {
    executeStep();
    res.status(200).json({ ok: true, caller: req.caller });
  });
  app.use(
    '/tasks',
    requireCaller('cloud-tasks', {
      verifyToken: fakeVerifier,
      audience: AUDIENCE,
      expectedEmail: QUEUE_SA,
      logger: captured.logger,
    }),
    tasks,
  );

  const lookup = express.Router();
  lookup.get('/users', (req, res) => {
    lookupUsers();
    res.status(200).json({ ok: true, caller: req.caller });
  });
  app.use(
    '/lookup',
    requireCaller('api-service', {
      verifyToken: fakeVerifier,
      audience: AUDIENCE,
      expectedEmail: API_SA,
      logger: captured.logger,
    }),
    lookup,
  );

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function call(path: string, bearer?: string, method = 'POST') {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: bearer } : {}),
    },
    body: method === 'POST' ? '{}' : undefined,
  });
}

describe('worker caller admission on /tasks', () => {
  it('admits the Cloud Tasks queue invoker', async () => {
    executeStep.mockClear();
    const res = await call('/tasks/execute-step', `Bearer ${token({ email: QUEUE_SA, email_verified: true })}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, caller: 'cloud-tasks' });
    expect(executeStep).toHaveBeenCalledTimes(1);
  });

  it('rejects an unauthenticated request without invoking the handler', async () => {
    executeStep.mockClear();
    const res = await call('/tasks/execute-step');
    expect(res.status).toBe(401);
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('rejects an authorization header that is not a bearer token', async () => {
    executeStep.mockClear();
    const res = await call('/tasks/execute-step', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('rejects the lifecycle-api identity, which is admitted on the lookup routes', async () => {
    executeStep.mockClear();
    const res = await call('/tasks/execute-step', `Bearer ${token({ email: API_SA, email_verified: true })}`);
    expect(res.status).toBe(401);
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('rejects a token issued to any other service account', async () => {
    executeStep.mockClear();
    const res = await call('/tasks/execute-step', `Bearer ${token({ email: OTHER_SA, email_verified: true })}`);
    expect(res.status).toBe(401);
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('rejects a token whose email is not verified', async () => {
    const res = await call('/tasks/execute-step', `Bearer ${token({ email: QUEUE_SA, email_verified: false })}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token carrying no email claim', async () => {
    const res = await call('/tasks/execute-step', `Bearer ${token({ email_verified: true })}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token minted for a different audience', async () => {
    const res = await call(
      '/tasks/execute-step',
      `Bearer ${token({ email: QUEUE_SA, email_verified: true, aud: 'https://someone-elses-service.run.app' })}`,
    );
    expect(res.status).toBe(401);
  });

  it('rejects a token that fails signature verification', async () => {
    const res = await call(
      '/tasks/execute-step',
      `Bearer ${token({ email: QUEUE_SA, email_verified: true, signature: 'bad' })}`,
    );
    expect(res.status).toBe(401);
  });
});

describe('worker caller admission on /lookup', () => {
  it('admits the lifecycle-api service account', async () => {
    lookupUsers.mockClear();
    const res = await call('/lookup/users', `Bearer ${token({ email: API_SA, email_verified: true })}`, 'GET');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, caller: 'api-service' });
    expect(lookupUsers).toHaveBeenCalledTimes(1);
  });

  it('rejects the Cloud Tasks queue invoker, mirroring the confinement', async () => {
    lookupUsers.mockClear();
    const res = await call('/lookup/users', `Bearer ${token({ email: QUEUE_SA, email_verified: true })}`, 'GET');
    expect(res.status).toBe(401);
    expect(lookupUsers).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    lookupUsers.mockClear();
    const res = await call('/lookup/users', undefined, 'GET');
    expect(res.status).toBe(401);
    expect(lookupUsers).not.toHaveBeenCalled();
  });
});

describe('the gate is scoped to its route class', () => {
  it('leaves the platform health check reachable without a token', async () => {
    const res = await call('/healthz', undefined, 'GET');
    expect(res.status).toBe(200);
  });
});

describe('refusal logging', () => {
  it('records the reason and source but never the bearer token', async () => {
    const secret = token({ email: OTHER_SA, email_verified: true });
    captured.lines.length = 0;
    await call('/tasks/execute-step', `Bearer ${secret}`);

    expect(captured.lines.length).toBeGreaterThan(0);
    const record = JSON.parse(captured.lines.at(-1)!);
    expect(record.reason).toContain(OTHER_SA);
    expect(record.sourceIp).toBeTruthy();
    expect(record.path).toBe('/execute-step');

    for (const line of captured.lines) {
      expect(line).not.toContain(secret);
    }
  });
});
