import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

/**
 * The single outbound-message seam (REQ-004 AC-7, REQ-032 AC-9).
 *
 * Both the welcome letter and the approver notice go through this one
 * interface, so choosing a provider is a configuration decision rather than a
 * code change, and there is exactly one delivery path to reason about. A second
 * path would mean a second sender address, a second set of credentials and a
 * second place for a message to go missing.
 *
 * The worker is the only service that holds an SMTP credential. The API service
 * never sends: it enqueues, and the worker delivers (REQ-032).
 */

export interface Message {
  to: string[];
  subject: string;
  /** Plain text. No HTML: these messages carry no formatting worth the risk. */
  body: string;
}

export interface DeliveryReceipt {
  /**
   * The provider's identifier for the submission. Its presence is what makes a
   * resend a no-op, so a provider that cannot supply one is unusable here.
   */
  deliveryId: string;
  /**
   * Whether this provider can report asynchronous bounces at all.
   *
   * The Workspace SMTP relay cannot (REQ-028), and that limitation is recorded
   * rather than papered over: for the welcome letter this is the only channel
   * reaching a new hire, so an operator needs to know that "sent" means
   * "accepted by the relay" and nothing more (REQ-004 AC-6).
   */
  bounceReportingAvailable: boolean;
}

/**
 * The provider refused the submission. Carries whether another attempt could
 * plausibly succeed, because that is the difference between a step that retries
 * and one that stops and asks for a human (REQ-004 AC-5).
 */
export class NotificationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'NotificationError';
  }
}

export interface NotificationSender {
  send(message: Message): Promise<DeliveryReceipt>;
}

/** Reads the relay credential from Secret Manager. */
async function relayPassword(secretName: string): Promise<string> {
  const secrets = new SecretManagerServiceClient();
  const [version] = await secrets.accessSecretVersion({ name: `${secretName}/versions/latest` });
  const payload = version.payload?.data;
  if (!payload) throw new Error(`Secret ${secretName} has no payload`);
  return payload.toString();
}

/**
 * Everything the relay needs, supplied as configuration (REQ-028 AC-7).
 *
 * Host, port, sender and Return-Path are values, not constants in code, so
 * moving to another provider is an environment change plus a different
 * NotificationSender — never an edit to a step handler. The password is
 * deliberately NOT here: it is a secret name, resolved at send time.
 */
export interface SmtpSettings {
  host: string;
  port: number;
  sender: string;
  /**
   * The envelope sender, which is what a receiving MTA turns into Return-Path
   * and where it delivers a bounce (REQ-028 AC-6). Absent, bounces go back to
   * the no-reply account.
   */
  returnPath?: string | undefined;
  credentialSecret: string;
}

/**
 * The two things this class does not do itself, so a test can drive both
 * without a network or a Secret Manager project.
 */
export interface SmtpDeps {
  readPassword: (secretName: string) => Promise<string>;
  createTransport: (options: Record<string, unknown>) => Transporter;
}

/**
 * Sends through the Google Workspace SMTP relay (REQ-028).
 *
 * The relay accepts or refuses at submission and then goes quiet: there is no
 * webhook, no event stream, nothing to tell us a message bounced later. That is
 * why bounceReportingAvailable is false, and why REQ-030's resend path exists at
 * all — a letter that vanishes after acceptance has no other remedy.
 */
export class SmtpNotificationSender implements NotificationSender {
  private transporter: Transporter | undefined;
  private readonly deps: SmtpDeps;

  constructor(
    private readonly settings: SmtpSettings = {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      sender: config.SMTP_SENDER,
      returnPath: config.SMTP_RETURN_PATH,
      credentialSecret: config.SMTP_CREDENTIAL_SECRET,
    },
    deps: Partial<SmtpDeps> = {},
  ) {
    this.deps = {
      readPassword: deps.readPassword ?? relayPassword,
      createTransport: deps.createTransport ?? ((o) => nodemailer.createTransport(o)),
    };
  }

  private async connect(): Promise<Transporter> {
    if (this.transporter) return this.transporter;

    this.transporter = this.deps.createTransport({
      host: this.settings.host,
      port: this.settings.port,
      // STARTTLS on 587. Never `secure: false` with no upgrade: the relay
      // carries names and addresses of real people.
      secure: this.settings.port === 465,
      requireTLS: true,
      auth: {
        user: this.settings.sender,
        pass: await this.deps.readPassword(this.settings.credentialSecret),
      },
    });

    return this.transporter;
  }

  private async submit(message: Message): Promise<DeliveryReceipt> {
    const transporter = await this.connect();

    const info = await transporter.sendMail({
      from: this.settings.sender,
      to: message.to.join(', '),
      subject: message.subject,
      text: message.body,
      // The envelope, stated explicitly. MAIL FROM is what becomes Return-Path
      // at the receiving end, so this — not a Return-Path header, which
      // receiving MTAs overwrite — is what decides where a bounce goes.
      envelope: {
        from: this.settings.returnPath ?? this.settings.sender,
        to: message.to,
      },
    });

    return { deliveryId: info.messageId, bounceReportingAvailable: false };
  }

  async send(message: Message): Promise<DeliveryReceipt> {
    if (message.to.length === 0) {
      // Not a provider failure, and not something a retry fixes. Sending to
      // nobody must never look like a successful send (REQ-032 AC-7).
      throw new NotificationError('refusing to send a message with no recipients', false);
    }

    try {
      return await this.submit(message);
    } catch (err) {
      if (!isAuthFailure(err)) {
        throw new NotificationError(describe(err), isRetryable(err), { cause: err });
      }

      /**
       * AC-10: the app password was rotated under us.
       *
       * The transporter caches the password it authenticated with, so a
       * rotation would otherwise fail every send until the instance was
       * recycled — which on Cloud Run can be hours, and on a warm instance
       * indefinitely. Dropping the transporter forces `connect` to re-read
       * `versions/latest`, so the next attempt uses the new password and no
       * redeploy is involved.
       *
       * Exactly one retry. If the fresh credential is refused too, the
       * credential is wrong rather than stale, and looping would turn a
       * configuration error into an authentication storm against the relay.
       */
      this.transporter = undefined;

      try {
        return await this.submit(message);
      } catch (retryErr) {
        throw new NotificationError(describe(retryErr), isRetryable(retryErr), {
          cause: retryErr,
        });
      }
    }
  }
}

/**
 * SMTP reply codes: 4xx is a temporary failure the sender should retry, 5xx is
 * permanent. Anything without a code is a connection-level problem, which is
 * the most retryable case there is.
 */
function isRetryable(err: unknown): boolean {
  const code = (err as { responseCode?: unknown }).responseCode;
  if (typeof code !== 'number') return true;
  return code >= 400 && code < 500;
}

/**
 * The credentials were refused, as distinct from the message being refused.
 *
 * 535 is the rotation case. 534 and 530 are the tenant telling us the
 * authentication method is no longer acceptable, which a re-read also fixes
 * when the remedy was a new app password. EAUTH is nodemailer's own label for
 * the same class when no numeric code came back.
 */
function isAuthFailure(err: unknown): boolean {
  const code = (err as { responseCode?: unknown }).responseCode;
  return (
    (err as { code?: unknown }).code === 'EAUTH' || code === 530 || code === 534 || code === 535
  );
}

function describe(err: unknown): string {
  const code = (err as { responseCode?: unknown }).responseCode;
  const message = err instanceof Error ? err.message : String(err);
  return typeof code === 'number' ? `SMTP ${code}: ${message}` : message;
}
