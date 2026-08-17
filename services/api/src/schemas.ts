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

/** Phases with no implementation have no schema, so submission is refused. */
const PHASE_SCHEMAS: Partial<Record<Phase, z.ZodTypeAny>> = {
  create: createPayloadSchema,
  notify: notifyPayloadSchema,
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
  const groups = value.groups as string[] | undefined;
  if (groups) value.groups = [...new Set(groups)];

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

/** The submission envelope, distinct from the phase-specific payload. */
export const submitRequestSchema = z
  .object({
    phase: z.enum(['create', 'notify', 'update', 'delete']),
    payload: z.record(z.unknown()),
  })
  .strict();
