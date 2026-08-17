import type { OperatorRole } from '@lifecycle/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requireIdentity, type OperatorIdentity } from './middleware/iapAuth.js';

/**
 * Route authorisation: every route declares the role it needs, and the check
 * runs before the handler (REQ-012 AC-1).
 *
 * This file is the ENFORCEMENT POINT. Where the roles come from is the
 * resolver's business: BindingRoleResolver in roles.ts reads them from the role
 * binding store, which is what actually satisfies REQ-012.
 *
 * The default resolver here grants NOTHING. A route mounted without one is
 * refused for everyone rather than admitted by accident, which is the only safe
 * direction for a default in an authorisation module: forgetting to wire the
 * resolver should close the door, not open it.
 */

export interface RoleResolver {
  rolesFor(identity: OperatorIdentity): Promise<OperatorRole[]>;
}

/**
 * The fallback when no resolver is supplied: no roles, so every guarded route
 * refuses. Deliberately not a permissive default, and deliberately not the
 * earlier stand-in that granted 'requester' to everyone: that one made the
 * approve and reject routes unreachable while quietly admitting anyone to the
 * submission route.
 */
export const denyAllResolver: RoleResolver = {
  async rolesFor(): Promise<OperatorRole[]> {
    return [];
  },
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      roles?: OperatorRole[];
    }
  }
}

export interface AuthzOptions {
  resolver?: RoleResolver;
  /**
   * Records the refusal (REQ-010 AC-3). Carries the path and source IP as well
   * as the identity, because a role denial with neither says someone was turned
   * away and nothing about what they were reaching for.
   */
  onDenied?: (event: {
    identity: OperatorIdentity;
    required: OperatorRole;
    path: string;
    sourceIp: string;
  }) => void;
}

/**
 * Builds a middleware admitting only identities holding `required`.
 *
 * Runs after iapAuth, so the identity is already verified; requireIdentity
 * throws rather than returning null if the ordering is ever broken, which fails
 * a test loudly instead of running a route unauthenticated.
 */
export function requireRole(required: OperatorRole, options: AuthzOptions = {}): RequestHandler {
  const resolver = options.resolver ?? denyAllResolver;

  return async function authz(req: Request, res: Response, next: NextFunction): Promise<void> {
    const identity = requireIdentity(req);
    const roles = await resolver.rolesFor(identity);
    req.roles = roles;

    if (!roles.includes(required)) {
      // The refusal names what was needed, not what the caller has: telling an
      // operator their exact role set is more than a denial needs to say.
      options.onDenied?.({
        identity,
        required,
        path: req.originalUrl,
        sourceIp: req.ip ?? 'unknown',
      });
      res.status(403).json({ error: 'forbidden', requiredRole: required });
      return;
    }

    next();
  };
}
