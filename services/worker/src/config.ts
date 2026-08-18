import { z } from 'zod';

/**
 * Validated worker configuration. As in the API service, nothing reads
 * process.env directly and the service exits at startup rather than failing on
 * the first task.
 *
 * QUEUE_INVOKER_SA and API_SERVICE_SA are the two identities this service will
 * admit, each confined to its own routes. A wrong value here should stop the
 * service starting, not quietly open a route to the wrong caller.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(8080),

  GCP_PROJECT_ID: z.string().min(1),
  FIRESTORE_DATABASE: z.string().min(1).default('(default)'),

  TASKS_QUEUE: z.string().min(1),
  TASKS_LOCATION: z.string().min(1),
  WORKER_BASE_URL: z.string().url(),

  QUEUE_INVOKER_SA: z.string().email(),
  API_SERVICE_SA: z.string().email(),

  WORKSPACE_CUSTOMER_ID: z.string().min(1).default('my_customer'),
  WORKSPACE_MODE: z.enum(['live', 'dry-run']).default('live'),

  SMTP_HOST: z.string().min(1).default('smtp-relay.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SENDER: z.string().email(),
  // The envelope sender, and therefore where asynchronous bounces land
  // (REQ-028 AC-6). Optional because the service must still start without it;
  // absent, bounces return to the no-reply account, which is a mailbox nobody
  // reads. That is the honest default rather than a good one.
  SMTP_RETURN_PATH: z.string().email().optional(),
  SMTP_CREDENTIAL_SECRET: z.string().min(1),
  CREDENTIAL_KEY_SECRET: z.string().min(1),

  CONSOLE_BASE_URL: z.string().url(),

  // The log the audit mirror writes to, which a Terraform sink routes into the
  // locked-retention bucket (REQ-018). Optional so a deployment can start
  // before the sink exists; the sweep route then reports 'not_configured'
  // rather than silently doing nothing. AUDIT_LOG_VIEW is the bucket view
  // reconciliation reads back through, once entries no longer land in _Default.
  AUDIT_LOG_NAME: z.string().min(1).optional(),
  AUDIT_LOG_VIEW: z.string().min(1).optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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
 * property access instead, so validation still runs before any real use.
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
