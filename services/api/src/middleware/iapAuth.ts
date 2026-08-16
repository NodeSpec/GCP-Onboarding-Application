import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';
import { logger } from '../logging.js';

/**
 * Independent verification of the Identity-Aware Proxy assertion.
 *
 * IAP already authenticated the caller at the perimeter. This middleware does
 * not take that on trust: it verifies the signed assertion itself, so that
 * reaching the Cloud Run service by some other path is not the same as being
 * authorised. Every failure path rejects with 401 before any route handler
 * runs.
 *
 * Serves REQ-007.
 */

const IAP_ISSUER = 'https://cloud.google.com/iap';
const IAP_JWKS_URI = new URL('https://www.gstatic.com/iap/verify/public_key-jwk');
const ASSERTION_HEADER = 'x-goog-iap-jwt-assertion';

/**
 * createRemoteJWKSet caches keys in memory and re-fetches when it encounters a
 * key id it has not seen, with an internal cooldown so an attacker cannot use
 * unknown kids to drive unbounded fetches. A key id that is still unknown after
 * that refresh raises, and we reject.
 */
const jwks = createRemoteJWKSet(IAP_JWKS_URI, {
  cacheMaxAge: 3_600_000,
  cooldownDuration: 30_000,
});

export interface OperatorIdentity {
  /** Verified from the assertion's email claim. Never from a request field. */
  email: string;
  /** Stable Google subject identifier, from the sub claim. */
  subject: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: OperatorIdentity;
    }
  }
}

function reject(req: Request, res: Response, reason: string): void {
  // Log the reason and the source, never the assertion itself. A raw assertion
  // in a log is a replayable credential for the length of its validity.
  logger.warn({ reason, sourceIp: req.ip, path: req.path }, 'IAP assertion rejected');
  res.status(401).json({ error: 'unauthenticated' });
}

function identityFromClaims(claims: JWTPayload): OperatorIdentity | null {
  const email = typeof claims.email === 'string' ? claims.email : null;
  const subject = typeof claims.sub === 'string' ? claims.sub : null;
  if (!email || !subject) return null;
  return { email: email.toLowerCase(), subject };
}

export async function iapAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Local development only. loadConfig refuses this combination unless
  // NODE_ENV is development, so it cannot be reached in a deployed service.
  if (config.AUTH_MODE === 'dev-insecure') {
    req.identity = { email: config.DEV_OPERATOR_EMAIL!.toLowerCase(), subject: 'dev-subject' };
    next();
    return;
  }

  const assertion = req.header(ASSERTION_HEADER);
  if (!assertion) {
    reject(req, res, 'missing assertion header');
    return;
  }

  let claims: JWTPayload;
  try {
    const verified = await jwtVerify(assertion, jwks, {
      issuer: IAP_ISSUER,
      audience: config.IAP_AUDIENCE,
      algorithms: ['ES256'],
      clockTolerance: config.IAP_CLOCK_SKEW_SECONDS,
    });
    claims = verified.payload;
  } catch (err) {
    // Covers a bad signature, a wrong audience, a wrong issuer, an expired or
    // not-yet-valid token, and a key id still unknown after refresh. All of
    // them are the same answer to the caller.
    reject(req, res, err instanceof Error ? err.name : 'verification failed');
    return;
  }

  const identity = identityFromClaims(claims);
  if (!identity) {
    reject(req, res, 'assertion missing email or sub claim');
    return;
  }

  // Assign only from verified claims. Anything a client sent that looks like an
  // identity is discarded here and cannot influence what follows.
  req.identity = identity;
  next();
}

/**
 * Reads the identity established above. Throws rather than returning null, so a
 * handler mounted without the middleware fails loudly in tests instead of
 * running unauthenticated.
 */
export function requireIdentity(req: Request): OperatorIdentity {
  if (!req.identity) {
    throw new Error('requireIdentity called on a request that did not pass iapAuth');
  }
  return req.identity;
}
