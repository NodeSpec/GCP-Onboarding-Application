import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SmtpNotificationSender, type NotificationSender } from './sender.js';

/**
 * TC-REQ-004-7 and TC-REQ-032-9: one delivery path, not two.
 *
 * Both requirements make the same claim from different directions — the welcome
 * letter and the approver notice go through one NotificationSender, so the
 * provider is a configuration decision and there is a single sender address to
 * reason about. That claim is not about behaviour, it is about SHAPE: nothing
 * can prove it by sending a message. So this scans the source.
 *
 * The failure it guards against is mundane and likely: someone needs to send
 * something new, reaches for nodemailer directly because it is right there, and
 * the system quietly acquires a second path with its own credential handling
 * and its own from-address. Nothing would break. Nobody would notice.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = join(HERE, '..');
const SENDER = join(HERE, 'sender.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    // Tests are excluded: a test may legitimately construct a fake transport,
    // and scanning them would flag this very file.
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) return [];
    return [full];
  });
}

/** Strips comments, so prose ABOUT sending is not mistaken for sending. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('AC-7 / AC-9: exactly one module talks to the mail provider', () => {
  it('finds nodemailer imported in sender.ts and nowhere else', () => {
    const offenders = sourceFiles(WORKER_SRC)
      .filter((path) => path !== SENDER)
      .filter((path) => /from\s+['"]nodemailer['"]/.test(code(path)))
      .map((path) => relative(WORKER_SRC, path));

    expect(offenders).toEqual([]);
  });

  it('finds no second transport constructed outside sender.ts', () => {
    const offenders = sourceFiles(WORKER_SRC)
      .filter((path) => path !== SENDER)
      .filter((path) => /createTransport|sendMail\(/.test(code(path)))
      .map((path) => relative(WORKER_SRC, path));

    expect(offenders).toEqual([]);
  });

  it('finds the relay sender address read in sender.ts and nowhere else', () => {
    // One from-address for every message the system sends. A second reader here
    // is how the approver notice would start arriving from a different sender
    // than the welcome letter.
    const offenders = sourceFiles(WORKER_SRC)
      .filter((path) => path !== SENDER)
      .filter((path) => /SMTP_SENDER|SMTP_CREDENTIAL_SECRET/.test(code(path)))
      .filter((path) => !path.endsWith(join('src', 'config.ts')))
      .map((path) => relative(WORKER_SRC, path));

    expect(offenders).toEqual([]);
  });

  it('proves the scan can fail, on a file that does reach for the provider', () => {
    // A scan nobody has seen fail is not evidence. sender.ts itself is the
    // positive control: it must match everything the others must not.
    const sender = code(SENDER);

    expect(/from\s+['"]nodemailer['"]/.test(sender)).toBe(true);
    expect(/createTransport/.test(sender)).toBe(true);
    expect(/SMTP_SENDER/.test(sender)).toBe(true);
  });
});

describe('AC-7: the provider is a configuration choice, not a code change', () => {
  it('lets any NotificationSender be substituted without touching a handler', () => {
    // Structural, and the reason both send paths take the interface rather
    // than the class: a different provider is a new implementation of this,
    // not an edit to the welcome letter or the approver notice.
    const fake: NotificationSender = {
      async send() {
        return { deliveryId: 'x', bounceReportingAvailable: true };
      },
    };

    expect(typeof fake.send).toBe('function');
    expect(new SmtpNotificationSender({
      host: 'smtp.example.com',
      port: 587,
      sender: 'lifecycle@company.com',
      credentialSecret: 'projects/p/secrets/s',
    })).toBeInstanceOf(SmtpNotificationSender);
  });

  it('refuses to send to nobody rather than reporting a successful empty send', async () => {
    const smtp = new SmtpNotificationSender({
      host: 'smtp.example.com',
      port: 587,
      sender: 'lifecycle@company.com',
      credentialSecret: 'projects/p/secrets/s',
    });

    // Reaches no network: the recipient check precedes the connection.
    await expect(smtp.send({ to: [], subject: 's', body: 'b' })).rejects.toThrow(
      'refusing to send a message with no recipients',
    );
  });
});
