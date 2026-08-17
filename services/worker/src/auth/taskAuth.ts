import type { NextFunction, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import type { Logger } from 'pino';
import { config } from '../config.js';
import { logger as defaultLogger } from '../logging.js';

/**
 * Caller authentication for the worker, and the route isolation that bounds it.
 *
 * The worker has two machine callers and no human ones. Cloud Tasks drives step
 * execution on /tasks/*, and the API service reads the directory on /lookup/*.
 * Both present a Google-issued OIDC token, so the check is not just "is this a
 * valid token" but "is this the identity that belongs on THIS route".
 *
 * That distinction is the whole point. run.invoker is granted at the service
 * level and cannot tell routes apart, so IAM alone would let the API service
 * invoke step execution. Confining each identity to its own routes here is what
 * keeps the second caller from being a widening of what the API can do.
 *
 * Serves REQ-007, REQ-016 and REQ-029.
 */

const oauth = new OAuth2Client();

export type CallerKind = 'cloud-tasks' | 'api-service';

/** The subset of an OIDC payload this middleware makes decisions on. */
export interface CallerClaims {
  email?: string;
  email_verified?: boolean;
}

export type TokenVerifier = (idToken: string, audience: string) => Promise<CallerClaims | null>;

/**
 * Test seams. Verifying a Google-issued token needs Google's signing key, which
 * is not obtainable, so without an injectable verifier the route-isolation rule
 * could only be exercised against the live network. The defaults are the
 * production values, so no call site has to know these exist.
 */
export interface CallerAuthOptions {
  verifyToken?: TokenVerifier;
  audience?: string;
  expectedEmail?: string;
  logger?: Logger;
}

const verifyWithGoogle: TokenVerifier = async (idToken, audience) => {
  const ticket = await oauth.verifyIdToken({ idToken, audience });
  return ticket.getPayload() ?? null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller?: CallerKind;
    }
  }
}

/**
 * Builds a middleware that admits exactly one service account. Mount the
 * queue's identity on /tasks and the API service's on /lookup; each rejects the
 * other with 401.
 */
export function requireCaller(kind: CallerKind, options: CallerAuthOptions = {}) {
  const log = options.logger ?? defaultLogger;
  const verify = options.verifyToken ?? verifyWithGoogle;
  // Both fall back to configuration only when not supplied, so a test never
  // forces a full environment to be present.
  const expected = (
    options.expectedEmail ?? (kind === 'cloud-tasks' ? config.QUEUE_INVOKER_SA : config.API_SERVICE_SA)
  ).toLowerCase();
  const audience = options.audience ?? config.WORKER_BASE_URL;

  function refuse(req: Request, res: Response, reason: string): void {
    // Reason and source only. The bearer token is a usable credential for the
    // length of its validity and never belongs in a log line.
    log.warn({ reason, sourceIp: req.ip, path: req.path }, 'worker call refused');
    res.status(401).json({ error: 'unauthenticated' });
  }

  return async function callerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) {
      refuse(req, res, 'missing bearer token');
      return;
    }

    try {
      const payload = await verify(header.slice('Bearer '.length), audience);

      if (!payload || payload.email_verified !== true || typeof payload.email !== 'string') {
        refuse(req, res, 'token carries no verified email');
        return;
      }

      // The identity check. A valid token for the wrong service account is
      // refused here, which is what stops the API service reaching /tasks/*.
      if (payload.email.toLowerCase() !== expected) {
        refuse(req, res, `identity ${payload.email} is not admitted on this route class`);
        return;
      }

      req.caller = kind;
      next();
    } catch (err) {
      refuse(req, res, err instanceof Error ? err.name : 'token verification failed');
    }
  };
}
