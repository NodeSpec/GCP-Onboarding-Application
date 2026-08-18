import { z } from 'zod';

/**
 * One validated configuration module. Nothing else in the service reads
 * process.env directly; call sites import `config` instead.
 *
 * The service exits at startup on invalid configuration rather than failing
 * on the first request, because a missing IAP audience is a security
 * misconfiguration and should never reach a running listener.
 */

const AuthMode = z.enum(['iap', 'dev-insecure']);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    PORT: z.coerce.number().int().positive().default(8080),

    GCP_PROJECT_ID: z.string().min(1),
    FIRESTORE_DATABASE: z.string().min(1).default('(default)'),

    TASKS_QUEUE: z.string().min(1),
    TASKS_LOCATION: z.string().min(1),
    WORKER_BASE_URL: z.string().url(),
    QUEUE_INVOKER_SA: z.string().email(),

    CREDENTIAL_KEY_SECRET: z.string().min(1),

    /**
     * Comma-separated emails that always hold the admin role.
     *
     * The role binding store cannot bootstrap itself: granting the first admin
     * requires an admin, and a fresh deployment has none. Kept in configuration
     * rather than in the store deliberately, so changing who holds it takes a
     * deploy by whoever controls the infrastructure rather than an API call
     * (REQ-012).
     */
    BOOTSTRAP_ADMINS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),

    /**
     * The relay sending identity and the group that receives its bounces.
     * Both are protected from lifecycle targeting unconditionally (REQ-031
     * AC-2): without them this system cannot notify anyone, so a deployment
     * that could delete one is one request away from breaking its own
     * onboarding path. Optional because a deployment may not have wired the
     * relay yet (REQ-028); an unset value simply protects nothing extra.
     */
    SMTP_SENDER: z.string().email().optional(),
    RETURN_PATH_GROUP: z.string().email().optional(),

    /**
     * Comma-separated addresses that may never be targeted by a lifecycle
     * request (REQ-031).
     *
     * Several Workspace users are load-bearing for this application itself,
     * most pointedly the no-reply account whose credential sends every welcome
     * letter. Deleting it would stop onboarding for everyone with no obvious
     * cause: the letters simply stop arriving. Break-glass administrator
     * accounts and the Return-Path monitoring group have the same property.
     *
     * Added to the two above rather than replacing them, so a tenant can
     * protect its own break-glass accounts without waiting for a release
     * (AC-3) and without being able to unprotect the notification path.
     */
    PROTECTED_ACCOUNTS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),

    AUTH_MODE: AuthMode.default('iap'),
    IAP_AUDIENCE: z.string().optional(),
    IAP_CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(30),
    DEV_OPERATOR_EMAIL: z.string().email().optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((cfg, ctx) => {
    // The IAP audience is what binds this service to one specific backend
    // service. Without it there is nothing to check the assertion against.
    if (cfg.AUTH_MODE === 'iap' && !cfg.IAP_AUDIENCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IAP_AUDIENCE'],
        message: 'IAP_AUDIENCE is required when AUTH_MODE is "iap". Wire it from the Terraform output.',
      });
    }

    // Refuse to start with assertion verification disabled outside local
    // development. This is asserted by a test as well as here.
    if (cfg.AUTH_MODE === 'dev-insecure') {
      if (cfg.NODE_ENV !== 'development') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_MODE'],
          message: 'AUTH_MODE=dev-insecure is only permitted when NODE_ENV=development.',
        });
      }
      if (!cfg.DEV_OPERATOR_EMAIL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DEV_OPERATOR_EMAIL'],
          message: 'DEV_OPERATOR_EMAIL is required when AUTH_MODE is "dev-insecure".',
        });
      }
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  return parsed.data;
}

/**
 * Lazily resolved singleton. Evaluating at module scope would make every module
 * that imports config unimportable without a complete environment, which breaks
 * unit tests that never touch configuration at all. Resolution happens on first
 * property access instead, so the validation still runs before any real use.
 */
let cached: Config | undefined;

export const config: Config = new Proxy({} as Config, {
  get(_target, property) {
    cached ??= loadConfig();
    return cached[property as keyof Config];
  },
});

/** Test helper: forget the resolved configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}
