import type { OperatorRole } from '@lifecycle/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requireIdentity, type OperatorIdentity } from './middleware/iapAuth.js';

/**
 * Route authorisation: every route declares the role it needs, and the check
 * runs before the handler (REQ-012 AC-1).
 *
 * THE RESOLVER IS A SEAM, NOT THE IMPLEMENTATION. REQ-012 specifies a role
 * binding store keyed on the verified email, supporting individual and
 * group-based bindings, with binding changes audited. None of that exists yet.
 * What exists is the enforcement point: routes declare a role, the check runs
 * ahead of the handler, and refusals are 403.
 *
 * The provisional resolver below grants every verified operator the requester
 * role and nothing else, so approver-only and admin-only routes are refused for
 * everyone. That is deliberately the restrictive direction: while the binding
 * store is missing, the system withholds privilege rather than assuming it.
 *
 * REQ-012 is NOT satisfied by this file. Its criteria stay unmet until the
 * binding store lands and replaces the provisional resolver.
 */

export interface RoleResolver {
  rolesFor(identity: OperatorIdentity): Promise<OperatorRole[]>;
}

/**
 * Stand-in until the role binding store exists. Named to make its status
 * obvious at every call site rather than reading like a finished component.
 */
export const provisionalRequesterOnlyResolver: RoleResolver = {
  async rolesFor(): Promise<OperatorRole[]> {
    return ['requester'];
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
  onDenied?: (identity: OperatorIdentity, required: OperatorRole, path: string) => void;
}

/**
 * Builds a middleware admitting only identities holding `required`.
 *
 * Runs after iapAuth, so the identity is already verified; requireIdentity
 * throws rather than returning null if the ordering is ever broken, which fails
 * a test loudly instead of running a route unauthenticated.
 */
export function requireRole(required: OperatorRole, options: AuthzOptions = {}): RequestHandler {
  const resolver = options.resolver ?? provisionalRequesterOnlyResolver;

  return async function authz(req: Request, res: Response, next: NextFunction): Promise<void> {
    const identity = requireIdentity(req);
    const roles = await resolver.rolesFor(identity);
    req.roles = roles;

    if (!roles.includes(required)) {
      // The refusal names what was needed, not what the caller has: telling an
      // operator their exact role set is more than a denial needs to say.
      options.onDenied?.(identity, required, req.path);
      res.status(403).json({ error: 'forbidden', requiredRole: required });
      return;
    }

    next();
  };
}
