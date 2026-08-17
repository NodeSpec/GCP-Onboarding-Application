import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logging.js';

/**
 * Independent verification of the Identity-Aware Proxy assertion.
 *
 * IAP already authenticated the caller at the perimeter. This middleware does
 * not take that on trust: it verifies the signed assertion itself, so that
 * reaching the Cloud Run service by some other path is not the same as being
 * authorised. Every failure path rejects with 401 before any route handler
 * runs.
 *
 * The middleware is built by a factory rather than defined at module scope so
 * the key set, clock and logger can be substituted in tests. Verifying a JWT
 * requires a signing key, and there is no way to obtain Google's private key,
 * so without this seam the most security-critical code in the service could
 * only be tested against a live network dependency, which in practice means it
 * would not be tested at all.
 *
 * Serves REQ-007.
 */

export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_JWKS_URI = new URL('https://www.gstatic.com/iap/verify/public_key-jwk');
export const ASSERTION_HEADER = 'x-goog-iap-jwt-assertion';

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

export interface IapAuthOptions {
  /** The exact backend-service audience string. No default: a wrong or absent
   *  audience means assertions minted for another service would be accepted. */
  audience: string;
  issuer?: string;
  clockToleranceSeconds?: number;
  /**
   * Key resolver. Defaults to Google's remote JWK set. Tests pass a local set
   * built from a generated key pair.
   */
  keySet?: JWTVerifyGetKey;
  logger?: Logger;
  /**
   * Records the refusal when verification fails (REQ-010 AC-3).
   *
   * Optional, and awaited only on the refusal path, so a store outage cannot
   * turn a 401 into a 500: the caller is unauthenticated either way, and the
   * response must not depend on the audit write succeeding. A failure to record
   * is logged and the refusal still stands.
   */
  auditDenied?: (event: {
    reason: string;
    path: string;
    sourceIp: string;
  }) => Promise<void>;
  /**
   * Local development only. When set, verification is skipped and this identity
   * is used. loadConfig refuses the combination that produces this outside
   * NODE_ENV=development, so it cannot be reached in a deployed service.
   */
  bypassIdentity?: OperatorIdentity;
}

/**
 * The production key set. createRemoteJWKSet caches keys in memory and
 * re-fetches when it encounters a key id it has not seen, with a cooldown so an
 * attacker cannot use unknown kids to drive unbounded fetches. A key id still
 * unknown after that refresh raises, and we reject.
 */
function defaultKeySet(): JWTVerifyGetKey {
  return createRemoteJWKSet(IAP_JWKS_URI, {
    cacheMaxAge: 3_600_000,
    cooldownDuration: 30_000,
  });
}

function identityFromClaims(claims: JWTPayload): OperatorIdentity | null {
  const email = typeof claims.email === 'string' ? claims.email : null;
  const subject = typeof claims.sub === 'string' ? claims.sub : null;
  if (!email || !subject) return null;
  return { email: email.toLowerCase(), subject };
}

export function createIapAuth(options: IapAuthOptions): RequestHandler {
  const log = options.logger ?? defaultLogger;
  const issuer = options.issuer ?? IAP_ISSUER;
  const clockTolerance = options.clockToleranceSeconds ?? 30;
  const keySet = options.keySet ?? defaultKeySet();

  function reject(req: Request, res: Response, reason: string): void {
    // Log the reason and the source, never the assertion itself. A raw
    // assertion in a log is a replayable credential for the length of its
    // validity.
    const sourceIp = req.ip ?? 'unknown';
    log.warn({ reason, sourceIp, path: req.path }, 'IAP assertion rejected');

    // Audited as well as logged (REQ-010 AC-3). The response is sent without
    // waiting: a caller who failed verification learns nothing from how long
    // the audit write took, and a store outage must not convert a 401 into a
    // 500. NO IDENTITY is recorded - nothing about this caller was verified,
    // and writing a claimed email would let an attacker forge attribution.
    void options
      .auditDenied?.({ reason, path: req.path, sourceIp })
      .catch((err: unknown) => log.error({ err, reason }, 'failed to audit an assertion refusal'));

    res.status(401).json({ error: 'unauthenticated' });
  }

  return async function iapAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (options.bypassIdentity) {
      req.identity = options.bypassIdentity;
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
      const verified = await jwtVerify(assertion, keySet, {
        issuer,
        audience: options.audience,
        algorithms: ['ES256'],
        clockTolerance,
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

    // Assign only from verified claims. Anything a client sent that looks like
    // an identity is discarded here and cannot influence what follows.
    req.identity = identity;
    next();
  };
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
