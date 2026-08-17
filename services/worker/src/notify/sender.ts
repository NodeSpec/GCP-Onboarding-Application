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

/** Reads the relay credential from Secret Manager, once per instance. */
async function relayPassword(secretName: string): Promise<string> {
  const secrets = new SecretManagerServiceClient();
  const [version] = await secrets.accessSecretVersion({ name: `${secretName}/versions/latest` });
  const payload = version.payload?.data;
  if (!payload) throw new Error(`Secret ${secretName} has no payload`);
  return payload.toString();
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

  constructor(
    private readonly settings: {
      host: string;
      port: number;
      sender: string;
      credentialSecret: string;
    } = {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      sender: config.SMTP_SENDER,
      credentialSecret: config.SMTP_CREDENTIAL_SECRET,
    },
  ) {}

  private async connect(): Promise<Transporter> {
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: this.settings.host,
      port: this.settings.port,
      // STARTTLS on 587. Never `secure: false` with no upgrade: the relay
      // carries names and addresses of real people.
      secure: this.settings.port === 465,
      requireTLS: true,
      auth: {
        user: this.settings.sender,
        pass: await relayPassword(this.settings.credentialSecret),
      },
    });

    return this.transporter;
  }

  async send(message: Message): Promise<DeliveryReceipt> {
    if (message.to.length === 0) {
      // Not a provider failure, and not something a retry fixes. Sending to
      // nobody must never look like a successful send (REQ-032 AC-7).
      throw new NotificationError('refusing to send a message with no recipients', false);
    }

    const transporter = await this.connect();

    try {
      const info = await transporter.sendMail({
        from: this.settings.sender,
        to: message.to.join(', '),
        subject: message.subject,
        text: message.body,
      });

      return { deliveryId: info.messageId, bounceReportingAvailable: false };
    } catch (err) {
      throw new NotificationError(describe(err), isRetryable(err), { cause: err });
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

function describe(err: unknown): string {
  const code = (err as { responseCode?: unknown }).responseCode;
  const message = err instanceof Error ? err.message : String(err);
  return typeof code === 'number' ? `SMTP ${code}: ${message}` : message;
}
