import type { Transporter } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { NotificationError, SmtpNotificationSender, type SmtpSettings } from './sender.js';

/**
 * TC-REQ-028-7, -8 and -10: the relay as a configured, rotatable dependency.
 *
 * These are the three claims about the sender that are code rather than tenant
 * configuration. The rest of REQ-028 — that app passwords are available, that
 * the no-reply account exists, that SPF/DKIM/DMARC pass on a live send — is
 * proven against the real tenant and cannot be asserted here.
 *
 * Both the Secret Manager read and the transport construction are injected, so
 * every case below runs with no network and no GCP project. The production
 * defaults are the real ones; nothing about the shipped behaviour changes.
 */

const SETTINGS: SmtpSettings = {
  host: 'smtp-relay.gmail.com',
  port: 587,
  sender: 'no-reply@company.com',
  returnPath: 'onboarding-bounces@company.com',
  credentialSecret: 'projects/p/secrets/smtp-app-password',
};

interface Sent {
  from: unknown;
  to: unknown;
  envelope: { from?: unknown; to?: unknown } | undefined;
  subject: unknown;
  text: unknown;
}

/**
 * A transport that records what it was built with and what it was asked to
 * send, and fails on the attempts named in `failOn`.
 */
function fakeTransport(failOn: (attempt: number) => unknown | null = () => null) {
  const built: Record<string, unknown>[] = [];
  const sent: Sent[] = [];
  let attempt = 0;

  const createTransport = (options: Record<string, unknown>): Transporter => {
    built.push(options);
    return {
      async sendMail(mail: Record<string, unknown>) {
        attempt += 1;
        const failure = failOn(attempt);
        if (failure) throw failure;
        sent.push(mail as unknown as Sent);
        return { messageId: `msg-${attempt}` };
      },
    } as unknown as Transporter;
  };

  return { createTransport, built, sent };
}

/** An SMTP error as nodemailer surfaces one. */
function smtpError(message: string, responseCode?: number, code?: string) {
  return Object.assign(new Error(message), { responseCode, code });
}

const MESSAGE = { to: ['ada@personal.example'], subject: 'Your account', body: 'Welcome.' };

// --------------------------------------------------------------------- AC-7

describe('AC-7: host, port, sender and Return-Path come from configuration', () => {
  it('builds the transport from the supplied settings rather than constants', async () => {
    const transport = fakeTransport();
    const passwordReads: string[] = [];

    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async (name) => {
        passwordReads.push(name);
        return 'app-password-v1';
      },
    });

    await sender.send(MESSAGE);

    expect(transport.built[0]).toMatchObject({
      host: 'smtp-relay.gmail.com',
      port: 587,
      requireTLS: true,
      // 587 is STARTTLS, so the connection opens in the clear and upgrades.
      // `requireTLS` above is what makes the upgrade mandatory rather than
      // best-effort, which matters because the relay carries real names.
      secure: false,
      auth: { user: 'no-reply@company.com', pass: 'app-password-v1' },
    });

    // The password is a secret NAME in configuration, resolved at runtime.
    // Switching provider changes the value, not this code.
    expect(passwordReads).toEqual(['projects/p/secrets/smtp-app-password']);
  });

  it('sets the envelope sender to the configured Return-Path so bounces land there', async () => {
    // The envelope MAIL FROM, not a Return-Path header: a receiving MTA writes
    // Return-Path from the envelope and overwrites any header we supplied, so
    // a header would look right in the source and route bounces to the wrong
    // mailbox (REQ-028 AC-6).
    const transport = fakeTransport();
    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => 'pw',
    });

    await sender.send(MESSAGE);

    expect(transport.sent[0]!.envelope).toEqual({
      from: 'onboarding-bounces@company.com',
      to: ['ada@personal.example'],
    });
    // The visible From is still the no-reply account: the bounce mailbox is not
    // somewhere a new hire should be invited to reply.
    expect(transport.sent[0]!.from).toBe('no-reply@company.com');
  });

  it('falls back to the sender when no Return-Path is configured', async () => {
    // Bounces then return to a mailbox nobody reads. That is worse, and it is
    // why the value is configuration rather than a constant — but the service
    // must still send rather than refuse to start.
    const transport = fakeTransport();
    const sender = new SmtpNotificationSender(
      { ...SETTINGS, returnPath: undefined },
      { createTransport: transport.createTransport, readPassword: async () => 'pw' },
    );

    await sender.send(MESSAGE);

    expect(transport.sent[0]!.envelope).toEqual({
      from: 'no-reply@company.com',
      to: ['ada@personal.example'],
    });
  });
});

// --------------------------------------------------------------------- AC-8

describe('AC-8: a synchronous rejection is a typed error, not a swallowed one', () => {
  it('raises NotificationError carrying the reply code, marked retryable on a 4xx', async () => {
    const transport = fakeTransport((n) =>
      n === 1 ? smtpError('Too many messages', 421) : null,
    );
    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => 'pw',
    });

    const err = await sender.send(MESSAGE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotificationError);
    // Retryable, so the step is resumed rather than failed: the letter has not
    // been sent and the relay is telling us to come back.
    expect((err as NotificationError).retryable).toBe(true);
    // The reply code reaches the operator. "Delivery failed" would not tell
    // them whether to wait or to fix something.
    expect((err as NotificationError).message).toContain('421');
    expect((err as NotificationError).message).toContain('Too many messages');
    // The original is preserved for the log, not flattened into a string.
    expect((err as NotificationError).cause).toBeInstanceOf(Error);
  });

  it('marks a 5xx terminal, because retrying a permanent refusal only wastes the budget', async () => {
    const transport = fakeTransport((n) =>
      n === 1 ? smtpError('Recipient address rejected', 550) : null,
    );
    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => 'pw',
    });

    const err = await sender.send(MESSAGE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotificationError);
    expect((err as NotificationError).retryable).toBe(false);
    expect((err as NotificationError).message).toContain('550');
  });

  it('treats a connection-level failure with no reply code as retryable', async () => {
    // Nothing was refused; nothing was reached. That is the most retryable
    // case there is, and defaulting it to terminal would fail a request over a
    // transient network fault.
    const transport = fakeTransport((n) => (n === 1 ? new Error('ECONNRESET') : null));
    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => 'pw',
    });

    const err = await sender.send(MESSAGE).catch((e: unknown) => e);

    expect((err as NotificationError).retryable).toBe(true);
  });

  it('never reports a receipt for a send that was refused', async () => {
    // The property the criterion is really about. A sender that returned a
    // receipt here would have the step record a successful notification and
    // nobody would ever learn the new hire was not told.
    const transport = fakeTransport(() => smtpError('Recipient rejected', 550));
    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => 'pw',
    });

    await expect(sender.send(MESSAGE)).rejects.toBeInstanceOf(NotificationError);
    expect(transport.sent).toEqual([]);
  });
});

// -------------------------------------------------------------------- AC-10

describe('AC-10: rotating the app password is picked up without a redeploy', () => {
  it('re-reads the secret and retries once when the old password is refused', async () => {
    // The rotation sequence. The transporter caches the password it
    // authenticated with, so without this the first send after a rotation
    // fails and every send after it fails the same way until the instance is
    // recycled — which on a warm Cloud Run instance may be never.
    const transport = fakeTransport((n) => (n === 1 ? smtpError('Bad credentials', 535) : null));
    const versions = ['app-password-v1', 'app-password-v2'];
    let read = 0;

    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => versions[read++]!,
    });

    const receipt = await sender.send(MESSAGE);

    expect(receipt.deliveryId).toBe('msg-2');
    // Two transports built: the second carries the rotated password.
    expect(transport.built).toHaveLength(2);
    expect(transport.built[0]).toMatchObject({ auth: { pass: 'app-password-v1' } });
    expect(transport.built[1]).toMatchObject({ auth: { pass: 'app-password-v2' } });
    expect(read).toBe(2);
    // And the message went out. A rotation must not cost a welcome letter.
    expect(transport.sent).toHaveLength(1);
  });

  it('keeps using the refreshed credential for later sends', async () => {
    // The refresh has to stick. Re-reading Secret Manager on every send would
    // work and would also put a secret access on the hot path of every letter.
    const transport = fakeTransport((n) => (n === 1 ? smtpError('Bad credentials', 535) : null));
    const versions = ['v1', 'v2', 'v3'];
    let read = 0;

    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => versions[read++]!,
    });

    await sender.send(MESSAGE);
    await sender.send(MESSAGE);

    expect(read).toBe(2);
    expect(transport.built).toHaveLength(2);
  });

  it('gives up after one retry when the fresh credential is refused too', async () => {
    // Then the credential is wrong, not stale. Looping would turn a
    // configuration error into an authentication storm against the relay, and
    // Google locks an account out for repeated failures.
    const transport = fakeTransport(() => smtpError('Bad credentials', 535));
    let read = 0;

    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => `v${++read}`,
    });

    const err = await sender.send(MESSAGE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotificationError);
    expect(read).toBe(2);
    expect(transport.built).toHaveLength(2);
  });

  it('does not re-read the secret for a failure that is not about credentials', async () => {
    // A rejected recipient is not a rotation. Refreshing here would hit Secret
    // Manager on every bad address and hide the real reason behind an auth
    // retry.
    const transport = fakeTransport(() => smtpError('Recipient rejected', 550));
    let read = 0;

    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => `v${++read}`,
    });

    await expect(sender.send(MESSAGE)).rejects.toBeInstanceOf(NotificationError);
    expect(read).toBe(1);
    expect(transport.built).toHaveLength(1);
  });

  it('treats nodemailer’s EAUTH as the same rotation case', async () => {
    // Not every refusal comes back with a numeric code; nodemailer labels the
    // class itself, and a rotation that surfaced this way would otherwise be
    // missed.
    const transport = fakeTransport((n) =>
      n === 1 ? smtpError('Invalid login', undefined, 'EAUTH') : null,
    );
    let read = 0;

    const sender = new SmtpNotificationSender(SETTINGS, {
      createTransport: transport.createTransport,
      readPassword: async () => `v${++read}`,
    });

    await sender.send(MESSAGE);

    expect(read).toBe(2);
  });
});
