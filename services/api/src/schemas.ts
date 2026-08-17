import type { Phase } from '@lifecycle/shared';
import { z } from 'zod';

/**
 * Boundary validation for lifecycle request payloads.
 *
 * Runs BEFORE anything is persisted (REQ-001 AC-4). A payload that reaches
 * Firestore and is rejected later leaves a request nobody asked for sitting in
 * the operator's list, so the schema is the admission gate rather than a
 * convenience.
 *
 * Strict objects on purpose: an unrecognised field is refused rather than
 * silently dropped. A typo in an attribute name should fail loudly at
 * submission, not produce an account missing the attribute the operator
 * believed they had set.
 */

const email = z.string().trim().toLowerCase().email();

export const createPayloadSchema = z
  .object({
    primaryEmail: email,
    givenName: z.string().trim().min(1).max(60),
    familyName: z.string().trim().min(1).max(60),
    orgUnitPath: z
      .string()
      .trim()
      .regex(/^\/[^\s]*$/, 'orgUnitPath must start with / and contain no whitespace')
      .optional(),
    title: z.string().trim().max(120).optional(),
    department: z.string().trim().max(120).optional(),
    managerEmail: email.optional(),
    // Deduplicated at the boundary: two identical group entries would otherwise
    // become two assign-group steps racing on the same membership.
    groups: z.array(email).max(50).optional(),
  })
  .strict();

export type CreatePayload = z.infer<typeof createPayloadSchema>;

/**
 * Phase 2, and the resend path (REQ-030).
 *
 * notificationEmail is REQUIRED and is refused when it equals the primary
 * address. The new mailbox cannot be read until the first sign-in that the
 * letter is explaining, so sending there is a guaranteed dead end rather than an
 * edge case; catching it at the boundary tells the operator immediately instead
 * of after a step has run (REQ-004 AC-2).
 *
 * `regenerate` decides which credential step the plan gets, so it is a
 * submission-time decision rather than something the worker infers. Defaulting
 * it to false is the important half: resetting a real person's password is a
 * thing an operator asks for explicitly, never something that happens because a
 * stored credential quietly turned out to be unusable (REQ-030 AC-3, AC-4).
 */
export const notifyPayloadSchema = z
  .object({
    primaryEmail: email,
    givenName: z.string().trim().min(1).max(60),
    familyName: z.string().trim().min(1).max(60),
    notificationEmail: email,
    regenerate: z.boolean().optional().default(false),
  })
  .strict()
  .refine((p) => p.notificationEmail !== p.primaryEmail, {
    path: ['notificationEmail'],
    message:
      'the notification address must differ from the new primary mailbox, which cannot be read yet',
  });

/** The attribute fields of an update payload, in the order a diff lists them. */
export const ATTRIBUTE_FIELDS = [
  'givenName',
  'familyName',
  'title',
  'department',
  'managerEmail',
  'orgUnitPath',
] as const;

/**
 * Phase 3: role and attribute updates (REQ-005).
 *
 * A desired-state submission, not a diff. The operator names the fields they
 * want changed and the groups to add or remove; what that means against the
 * live account is computed at execution time and frozen onto the request (AC-1).
 *
 * Three shapes of "no value" are distinguished, and that distinction is why
 * these are nullable rather than merely optional. An ABSENT field is not being
 * changed. An explicit null CLEARS it, which is a real thing an operator asks
 * for when someone stops reporting to a manager or leaves a department. The
 * empty string is neither, so it is refused rather than quietly treated as one
 * of them. Name and org unit cannot be cleared at all: an account with no name
 * is not a state Workspace has, and every user is in some org unit.
 */
export const updatePayloadSchema = z
  .object({
    primaryEmail: email,
    givenName: z.string().trim().min(1).max(60).optional(),
    familyName: z.string().trim().min(1).max(60).optional(),
    title: z.string().trim().min(1).max(120).nullable().optional(),
    department: z.string().trim().min(1).max(120).nullable().optional(),
    managerEmail: email.nullable().optional(),
    orgUnitPath: z
      .string()
      .trim()
      .regex(/^\/[^\s]*$/, 'orgUnitPath must start with / and contain no whitespace')
      .optional(),
    addGroups: z.array(email).max(50).optional(),
    removeGroups: z.array(email).max(50).optional(),
  })
  .strict()
  .refine(
    (p) =>
      ATTRIBUTE_FIELDS.some((field) => p[field] !== undefined) ||
      (p.addGroups?.length ?? 0) > 0 ||
      (p.removeGroups?.length ?? 0) > 0,
    {
      // Without this an operator could submit a request that plans no work at
      // all, which would run to 'succeeded' having changed nothing and read as
      // a completed update.
      message: 'an update must change at least one attribute or group membership',
    },
  )
  .refine(
    (p) => {
      const adds = new Set(p.addGroups ?? []);
      return (p.removeGroups ?? []).every((group) => !adds.has(group));
    },
    {
      path: ['removeGroups'],
      // The add step and the remove step would race, and which one happened to
      // land last would decide the membership.
      message: 'a group cannot be both added and removed in one request',
    },
  );

/**
 * Phase 4: offboarding (REQ-006).
 *
 * Two optional fields, and both change the plan rather than a step's behaviour.
 * `transferDriveTo` adds the data-transfer step; its absence means the files go
 * with the account, which is a decision an operator makes explicitly rather
 * than one this system makes for them. `holdHours` is the window between
 * suspension and deletion during which the request can still be cancelled.
 *
 * The successor is refused when it equals the account being deleted: Workspace
 * would accept the transfer and it would achieve nothing, leaving an operator
 * believing the files were saved.
 */
export const deletePayloadSchema = z
  .object({
    primaryEmail: email,
    transferDriveTo: email.optional(),
    // Capped at 30 days. A hold is a pause, not an archive, and a request left
    // in flight for a year is a stuck job by any other name.
    holdHours: z.number().int().min(1).max(720).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((p) => p.transferDriveTo === undefined || p.transferDriveTo !== p.primaryEmail, {
    path: ['transferDriveTo'],
    message: 'the Drive successor must be a different account from the one being deleted',
  });

/** Phases with no implementation have no schema, so submission is refused. */
const PHASE_SCHEMAS: Partial<Record<Phase, z.ZodTypeAny>> = {
  create: createPayloadSchema,
  notify: notifyPayloadSchema,
  update: updatePayloadSchema,
  delete: deletePayloadSchema,
};

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: ValidationIssue[] };

export function validatePayload(phase: Phase, payload: unknown): ValidationResult {
  const schema = PHASE_SCHEMAS[phase];
  if (!schema) {
    return { ok: false, issues: [{ path: 'phase', message: `phase '${phase}' is not implemented` }] };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }

  const value = parsed.data as Record<string, unknown>;
  // Deduplicated after parsing rather than in the schema, so the group lists of
  // every phase are normalised in one place. Two identical entries would
  // otherwise become two steps racing on the same membership.
  for (const field of ['groups', 'addGroups', 'removeGroups']) {
    const list = value[field] as string[] | undefined;
    if (list) value[field] = [...new Set(list)];
  }

  return { ok: true, value };
}

/**
 * An approval decision. The justification is trimmed then length-checked, so a
 * whitespace-only string is refused rather than stored as an empty audit
 * record. Enforced here on the server, independently of any client-side check
 * (REQ-002 AC-5).
 */
export const decisionSchema = z
  .object({
    justification: z.string().trim().min(1, 'a justification is required').max(2000),
  })
  .strict();

/**
 * A cancellation. The reason is required for the same reason an approval
 * justification is: cancelling an offboarding mid-flight is a decision someone
 * will ask about later, and 'cancelled by operator@company.com' on its own does
 * not answer them.
 */
export const cancelSchema = z
  .object({
    reason: z.string().trim().min(1, 'a reason is required').max(2000),
  })
  .strict();

/** The submission envelope, distinct from the phase-specific payload. */
export const submitRequestSchema = z
  .object({
    phase: z.enum(['create', 'notify', 'update', 'delete']),
    payload: z.record(z.unknown()),
  })
  .strict();
