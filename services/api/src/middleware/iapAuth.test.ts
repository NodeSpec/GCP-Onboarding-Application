import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWK, JWTVerifyGetKey, KeyLike } from 'jose';
import pino from 'pino';
import { Writable } from 'node:stream';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ASSERTION_HEADER, IAP_ISSUER, createIapAuth } from './iapAuth.js';
import type { Request, Response } from 'express';

/**
 * TC-REQ-007-1 through TC-REQ-007-8.
 *
 * Real ES256 assertions are minted with a locally generated key pair and
 * verified through the same jose path production uses. Only the key source is
 * substituted, so a pass means the real verification logic made the decision.
 * Each failure case differs from the valid token in exactly one property, so a
 * rejection is attributable to the property under test.
 */

const AUDIENCE = '/projects/123456/global/backendServices/789';

let privateKey: KeyLike;
let publicJwk: JWK;
let keySet: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key-1', alg: 'ES256' };
  keySet = createLocalJWKSet({ keys: [publicJwk] });
});

async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const {
    issuer = IAP_ISSUER,
    audience = AUDIENCE,
    expiresIn = '5m',
    kid = 'test-key-1',
    signer = privateKey,
    claims = { email: 'Operator@Company.com', sub: 'sub-abc-123' },
  } = overrides as Record<string, never>;

  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: 'ES256', kid: kid as string })
    .setIssuedAt()
    .setIssuer(issuer as string)
    .setAudience(audience as string)
    .setExpirationTime(expiresIn as string)
    .sign(signer as KeyLike);
}

function fakeReq(headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    header: (name: string) => lower[name.toLowerCase()],
    ip: '203.0.113.9',
    path: '/api/requests',
    ...extra,
  } as unknown as Request;
}

function fakeRes() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  };
  return { res: res as unknown as Response, state };
}

/** Captures emitted log lines so assertions can inspect what was written. */
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

function middleware(overrides: Partial<Parameters<typeof createIapAuth>[0]> = {}) {
  return createIapAuth({ audience: AUDIENCE, keySet, ...overrides });
}

describe('IAP assertion verification', () => {
  it('AC-1: rejects a request with no assertion header, without invoking the handler', async () => {
    const next = vi.fn();
    const { res, state } = fakeRes();

    await middleware()(fakeReq(), res, next);

    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: 'unauthenticated' });
    expect(next).not.toHaveBeenCalled();
  });

  it('AC-2: rejects an assertion signed by the wrong key', async () => {
    const impostor = await generateKeyPair('ES256');
    const token = await mint({ signer: impostor.privateKey });
    const next = vi.fn();
    const { res, state } = fakeRes();

    await middleware()(fakeReq({ [ASSERTION_HEADER]: token }), res, next);

    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('AC-3: rejects an assertion minted for a different backend service', async () => {
    const token = await mint({ audience: '/projects/123456/global/backendServices/999' });
    const next = vi.fn();
    const { res, state } = fakeRes();

    await middleware()(fakeReq({ [ASSERTION_HEADER]: token }), res, next);

    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('AC-4: rejects an assertion from a different issuer', async () => {
    const token = await mint({ issuer: 'https://accounts.google.com' });
    const next = vi.fn();
    const { res, state } = fakeRes();

    await middleware()(fakeReq({ [ASSERTION_HEADER]: token }), res, next);

    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('AC-5: rejects an expired assertion beyond the configured skew', async () => {
    const token = await mint({ expiresIn: '-2m' });
    const next = vi.fn();
    const { res, state } = fakeRes();

    await middleware({ clockToleranceSeconds: 30 })(
      fakeReq({ [ASSERTION_HEADER]: token }),
      res,
      next,
    );

    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('AC-5b: accepts an assertion expired within the skew', async () => {
    // Proves the skew is a real tolerance rather than an unused option, and
    // that AC-5 above fails for expiry rather than for some other reason.
    const token = await mint({ expiresIn: '-10s' });
    const next = vi.fn();
    const { res } = fakeRes();

    await middleware({ clockToleranceSeconds: 60 })(
      fakeReq({ [ASSERTION_HEADER]: token }),
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
  });

  it('AC-6: populates identity from verified claims and lowercases the email', async () => {
    const token = await mint();
    const next = vi.fn();
    const { res } = fakeRes();
    const req = fakeReq({ [ASSERTION_HEADER]: token });

    await middleware()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.identity).toEqual({ email: 'operator@company.com', subject: 'sub-abc-123' });
  });

  it('AC-6b: ignores a client-supplied identity header and body field', async () => {
    const token = await mint();
    const next = vi.fn();
    const { res } = fakeRes();
    const req = fakeReq(
      {
        [ASSERTION_HEADER]: token,
        'x-goog-authenticated-user-email': 'attacker@evil.example',
      },
      { body: { identity: { email: 'attacker@evil.example', subject: 'spoofed' } } },
    );

    await middleware()(req, res, next);

    expect(req.identity?.email).toBe('operator@company.com');
    expect(req.identity?.subject).toBe('sub-abc-123');
  });

  it('AC-6c: rejects a validly signed assertion missing the email claim', async () => {
    const token = await mint({ claims: { sub: 'sub-abc-123' } });
    const next = vi.fn();
    const { res, state } = fakeRes();

    await middleware()(fakeReq({ [ASSERTION_HEADER]: token }), res, next);

    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('AC-7: rejects a key id absent from the set', async () => {
    const token = await mint({ kid: 'rotated-away' });
    const next = vi.fn();
    const { res, state } = fakeRes();

    await middleware()(fakeReq({ [ASSERTION_HEADER]: token }), res, next);

    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('AC-7b: succeeds when a refreshed set contains the previously unknown key', async () => {
    // Models the refresh path: the resolver knows nothing on first use and the
    // key afterwards. Production uses createRemoteJWKSet, whose refresh-on-
    // unknown-kid behaviour this mirrors.
    const pair = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'rotated-in', alg: 'ES256' };

    let refreshed = false;
    const refreshingSet: JWTVerifyGetKey = async (header, token) => {
      if (!refreshed) {
        refreshed = true;
        throw new Error('unknown kid');
      }
      return createLocalJWKSet({ keys: [jwk] })(header, token);
    };

    const assertion = await mint({ kid: 'rotated-in', signer: pair.privateKey });

    const firstAttempt = fakeRes();
    await middleware({ keySet: refreshingSet })(
      fakeReq({ [ASSERTION_HEADER]: assertion }),
      firstAttempt.res,
      vi.fn(),
    );
    expect(firstAttempt.state.status).toBe(401);

    const next = vi.fn();
    const { res } = fakeRes();
    await middleware({ keySet: refreshingSet })(
      fakeReq({ [ASSERTION_HEADER]: assertion }),
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it('AC-8: logs the reason and source IP but never the raw assertion', async () => {
    const token = await mint({ audience: 'wrong-audience' });
    const { logger, lines } = capturingLogger();
    const { res } = fakeRes();

    await middleware({ logger })(fakeReq({ [ASSERTION_HEADER]: token }), res, vi.fn());

    const emitted = lines.join('');
    expect(emitted).toContain('203.0.113.9');
    expect(emitted).toContain('reason');
    // The assertion is a bearer credential for as long as it is valid. Logging
    // it would put a replayable token in the log sink.
    expect(emitted).not.toContain(token);
  });

  it('fails closed when the key source is unavailable', async () => {
    // A network failure fetching the JWK set must not become an open door.
    const unavailable: JWTVerifyGetKey = async () => {
      throw new Error('ENOTFOUND gstatic.com');
    };
    const token = await mint();
    const next = vi.fn();
    const { res, state } = fakeRes();

    await middleware({ keySet: unavailable })(fakeReq({ [ASSERTION_HEADER]: token }), res, next);

    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('bypass mode assigns the configured identity without verification', async () => {
    const next = vi.fn();
    const { res } = fakeRes();
    const req = fakeReq();

    await middleware({ bypassIdentity: { email: 'dev@company.com', subject: 'dev-subject' } })(
      req,
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(req.identity?.email).toBe('dev@company.com');
  });
});
