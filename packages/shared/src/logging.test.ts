import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveKey, redact } from './logging.js';

/**
 * TC-REQ-010-6, and supporting evidence for TC-REQ-003-7 and TC-REQ-019-5.
 *
 * The criterion asks for a test that logs a payload containing each sensitive
 * field and asserts on the emitted record. These tests exercise the redaction
 * transform directly, which is the same function pino applies through
 * formatters.log, so a pass here is evidence for every sink rather than for one
 * call site.
 */

const SECRET = 'super-secret-value';

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'Password',
    'oneTimePassword',
    'ciphertext',
    'secret',
    'smtpCredential',
    'apiKey',
    'token',
    'refreshToken',
    'assertion',
    'authorization',
    'x-goog-iap-jwt-assertion',
  ])('censors %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['email', 'requestId', 'status', 'targetUser', 'orgUnitPath', 'attempts'])(
    'leaves %s alone',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  /**
   * Fragment matching is what catches the field nobody predicted. A future
   * `smtpAppPassword` or `signingSecret` is censored without anyone editing
   * the list.
   */
  it('censors unanticipated keys containing a sensitive fragment', () => {
    expect(isSensitiveKey('smtpAppPassword')).toBe(true);
    expect(isSensitiveKey('signingSecret')).toBe(true);
    expect(isSensitiveKey('userCredentialBlob')).toBe(true);
    expect(isSensitiveKey('iapAssertionHeader')).toBe(true);
  });
});

describe('redact', () => {
  it('censors sensitive values at the top level', () => {
    const output = redact({ email: 'op@company.com', password: SECRET }) as Record<string, unknown>;
    expect(output.email).toBe('op@company.com');
    expect(output.password).toBe(REDACTED);
  });

  /**
   * The reason redaction walks by key name rather than by declared path: a
   * secret nested somewhere nobody predicted still gets censored.
   */
  it('censors at arbitrary depth', () => {
    const output = redact({
      step: { input: { context: { oneTimePassword: SECRET } } },
    });
    expect(JSON.stringify(output)).not.toContain(SECRET);
  });

  it('censors inside arrays', () => {
    const output = redact({ attempts: [{ token: SECRET }, { token: SECRET }] });
    expect(JSON.stringify(output)).not.toContain(SECRET);
  });

  it('censors inside an Error cause chain', () => {
    const inner = new Error('inner failure');
    Object.assign(inner, { apiKey: SECRET });
    const outer = new Error('outer failure', { cause: inner });

    const output = redact({ err: outer });
    expect(JSON.stringify(output)).not.toContain(SECRET);
  });

  it('preserves error name, message and stack so failures stay diagnosable', () => {
    const err = new Error('directory call failed');
    const output = redact({ err }) as { err: Record<string, unknown> };
    expect(output.err.name).toBe('Error');
    expect(output.err.message).toBe('directory call failed');
    expect(output.err.stack).toBeTypeOf('string');
  });

  /**
   * A logger that throws is worse than a logger that leaks, because it takes
   * the request down with it. Error cause chains are a realistic source of
   * cycles.
   */
  it('survives a circular reference', () => {
    const cyclic: Record<string, unknown> = { requestId: 'req-1' };
    cyclic.self = cyclic;

    expect(() => redact(cyclic)).not.toThrow();
    const output = redact(cyclic) as Record<string, unknown>;
    expect(output.self).toBe('[circular]');
  });

  it('leaves primitives and null untouched', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });

  /**
   * The end-to-end shape the criterion describes: one payload carrying every
   * sensitive field, asserted to emit none of them.
   */
  it('emits no sensitive value from a payload containing all of them', () => {
    const payload = {
      requestId: 'req-1',
      password: SECRET,
      oneTimePassword: SECRET,
      ciphertext: SECRET,
      secret: SECRET,
      smtpCredential: SECRET,
      apiKey: SECRET,
      token: SECRET,
      assertion: SECRET,
      authorization: `Bearer ${SECRET}`,
    };

    const emitted = JSON.stringify(redact(payload));
    expect(emitted).not.toContain(SECRET);
    expect(emitted).toContain('req-1');
  });
});
