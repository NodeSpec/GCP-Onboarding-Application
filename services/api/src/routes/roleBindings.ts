import type { LifecycleStore, OperatorRole } from '@lifecycle/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type RoleResolver } from '../authz.js';
import { guarded } from '../middleware/asyncGuard.js';
import { requireIdentity } from '../middleware/iapAuth.js';

/**
 * Administration of the role binding store (REQ-012).
 *
 * Every route here is admin-only. That is the point at which privilege becomes
 * self-referential, so it is worth being explicit: an admin can grant admin.
 * The defence is not a restriction in code but the audit trail — every change
 * records the actor, the subject, and the roles before and after (AC-6) — plus
 * the fact that the FIRST admin can only come from configuration, never from
 * this API.
 *
 * Bindings are keyed on the verified email. A 'user' binding names a person; a
 * 'group' binding names a Google group, and any member of it inherits the roles
 * (AC-7).
 */

export interface RoleBindingRouteDeps {
  store: LifecycleStore;
  resolver?: RoleResolver;
  /** Called after a change so a cached role decision cannot outlive it. */
  onChanged?: (subject: string) => void;
}

const ROLES: readonly OperatorRole[] = ['requester', 'approver', 'admin'];

const bindingSchema = z
  .object({
    kind: z.enum(['user', 'group']),
    // An empty array is refused rather than treated as a removal: deleting a
    // binding is DELETE, and letting PUT mean either would make an accidental
    // empty payload silently strip someone's access.
    roles: z.array(z.enum(['requester', 'approver', 'admin'])).min(1).max(ROLES.length),
  })
  .strict();

const subjectSchema = z.string().trim().toLowerCase().email();

export function roleBindingRoutes(deps: RoleBindingRouteDeps): Router {
  const router = Router();
  const authz = { ...(deps.resolver === undefined ? {} : { resolver: deps.resolver }) };

  // Every handler below is guarded: they all await the store, and an unguarded
  // rejection from an async handler kills the process rather than answering
  // 500 (see middleware/asyncGuard.ts).
  router.get('/', requireRole('admin', authz), guarded(async (_req, res) => {
    res.status(200).json({ bindings: await deps.store.listRoleBindings() });
  }));

  router.put('/:subject', requireRole('admin', authz), guarded(async (req, res) => {
    const subject = subjectSchema.safeParse(req.params.subject);
    if (!subject.success) {
      res.status(400).json({ error: 'invalid_subject', message: 'subject must be an email address' });
      return;
    }

    const parsed = bindingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_binding',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      });
      return;
    }

    const identity = requireIdentity(req);
    const outcome = await deps.store.setRoleBinding({
      subject: subject.data,
      kind: parsed.data.kind,
      roles: parsed.data.roles,
      actor: { kind: 'human', email: identity.email },
    });

    deps.onChanged?.(subject.data);

    // 201 when the binding is new, 200 when it replaced one, so a caller can
    // tell a grant from an edit without re-reading.
    res.status(outcome.before === null ? 201 : 200).json({
      subject: subject.data,
      kind: parsed.data.kind,
      roles: outcome.after,
      previousRoles: outcome.before,
    });
  }));

  router.delete('/:subject', requireRole('admin', authz), guarded(async (req, res) => {
    const subject = subjectSchema.safeParse(req.params.subject);
    if (!subject.success) {
      res.status(400).json({ error: 'invalid_subject', message: 'subject must be an email address' });
      return;
    }

    const identity = requireIdentity(req);
    const outcome = await deps.store.removeRoleBinding({
      subject: subject.data,
      actor: { kind: 'human', email: identity.email },
    });

    deps.onChanged?.(subject.data);

    if (outcome.before === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.status(200).json({ subject: subject.data, previousRoles: outcome.before });
  }));

  return router;
}
