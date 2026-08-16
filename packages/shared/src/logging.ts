import pino, { type Logger } from 'pino';

/**
 * The structured logger, and the one redaction filter that applies to every
 * sink in both services.
 *
 * Redaction is done by walking the log object and censoring by KEY NAME at any
 * depth, rather than with pino's path-based `redact` option. Path redaction
 * needs you to know where a secret will appear, and the whole failure mode here
 * is a secret appearing somewhere nobody predicted, nested inside an error
 * cause or a request payload.
 *
 * Serves REQ-010.
 */

/** Censored by exact key name, case insensitive. */
const SENSITIVE_KEYS = new Set([
  'password',
  'onetimepassword',
  'newpassword',
  'ciphertext',
  'onetimepasswordciphertext',
  'secret',
  'secretvalue',
  'smtpcredential',
  'apppassword',
  'apikey',
  'key',
  'privatekey',
  'token',
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'claimtoken',
  'assertion',
  'authorization',
  'x-goog-iap-jwt-assertion',
  'credentials',
]);

/** Censored when the key merely contains one of these. */
const SENSITIVE_FRAGMENTS = ['password', 'secret', 'credential', 'assertion'];

export const REDACTED = '[redacted]';

export function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase();
  if (SENSITIVE_KEYS.has(normalised)) return true;
  return SENSITIVE_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * Deep copy with sensitive values replaced. Handles cycles, because an Error
 * with a `cause` chain can easily be self referential and a logger must never
 * be the thing that crashes a request.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause === undefined ? undefined : redact(value.cause, seen),
    };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(entry, seen);
  }
  return output;
}

export function createLogger(options: { level?: string; name?: string } = {}): Logger {
  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    name: options.name,
    // Cloud Logging reads "severity", not pino's numeric "level".
    messageKey: 'message',
    formatters: {
      level(label) {
        return { severity: label.toUpperCase() };
      },
      log(object) {
        return redact(object) as Record<string, unknown>;
      },
    },
  });
}

export const logger: Logger = createLogger();
