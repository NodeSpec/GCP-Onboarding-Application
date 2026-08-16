import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/**
 * Configuration guard tests.
 *
 * These are the cheapest security tests in the repository and cover the one
 * escape hatch that could plausibly reach production: AUTH_MODE=dev-insecure
 * disables IAP assertion verification for local development. The requirement
 * (REQ-007) says it must not be deployable, and that claim is only true if
 * something asserts it.
 */

const BASE = {
  GCP_PROJECT_ID: 'company-lifecycle',
  TASKS_QUEUE: 'lifecycle-steps',
  TASKS_LOCATION: 'europe-west2',
  WORKER_BASE_URL: 'https://worker.example.com',
  QUEUE_INVOKER_SA: 'queue-invoker@company-lifecycle.iam.gserviceaccount.com',
  CREDENTIAL_KEY_SECRET: 'projects/1/secrets/credential-encryption-key',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('accepts a complete production configuration', () => {
    const config = loadConfig({
      ...BASE,
      NODE_ENV: 'production',
      IAP_AUDIENCE: '/projects/1/global/backendServices/2',
    });

    expect(config.AUTH_MODE).toBe('iap');
    expect(config.IAP_AUDIENCE).toBe('/projects/1/global/backendServices/2');
    expect(config.PORT).toBe(8080);
  });

  /**
   * Without an audience there is nothing to check an assertion against, so a
   * service that started anyway would accept tokens minted for a different
   * backend service.
   */
  it('refuses to start in iap mode without an audience', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production' })).toThrow(/IAP_AUDIENCE/);
  });

  /** The important one. */
  it('refuses dev-insecure outside development', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'production',
        AUTH_MODE: 'dev-insecure',
        DEV_OPERATOR_EMAIL: 'op@company.com',
      }),
    ).toThrow(/only permitted when NODE_ENV=development/);
  });

  it('refuses dev-insecure in test as well as production', () => {
    // 'test' is not 'development'. A CI run must not be able to exercise the
    // unauthenticated path by accident and report it as passing.
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'test',
        AUTH_MODE: 'dev-insecure',
        DEV_OPERATOR_EMAIL: 'op@company.com',
      }),
    ).toThrow(/only permitted when NODE_ENV=development/);
  });

  it('permits dev-insecure in development with an operator email', () => {
    const config = loadConfig({
      ...BASE,
      NODE_ENV: 'development',
      AUTH_MODE: 'dev-insecure',
      DEV_OPERATOR_EMAIL: 'op@company.com',
    });

    expect(config.AUTH_MODE).toBe('dev-insecure');
    expect(config.DEV_OPERATOR_EMAIL).toBe('op@company.com');
  });

  it('refuses dev-insecure without an operator identity to stand in', () => {
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'development', AUTH_MODE: 'dev-insecure' }),
    ).toThrow(/DEV_OPERATOR_EMAIL/);
  });

  it('reports every invalid field at once rather than the first', () => {
    // A config error should not be a guessing game one variable at a time.
    try {
      loadConfig({ NODE_ENV: 'production' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('GCP_PROJECT_ID');
      expect(message).toContain('TASKS_QUEUE');
    }
  });

  it('rejects a malformed worker URL', () => {
    expect(() =>
      loadConfig({ ...BASE, IAP_AUDIENCE: 'aud', WORKER_BASE_URL: 'not-a-url' }),
    ).toThrow(/WORKER_BASE_URL/);
  });
});
