import { describe, expect, it } from 'vitest';
import {
  ProtectedAccountError,
  ProtectedAccounts,
  defaultProtectedAccounts,
} from './protectedAccounts.js';

/**
 * TC-REQ-031-2, -3, -4 and the typed-error half of -1.
 *
 * The matching rules are the substance here. A protected account that can be
 * reached through an alias is not protected, so the alias cases are the tests
 * that would actually catch a regression; the exact-match case is the control
 * that keeps them honest.
 *
 * Admission behaviour (AC-1, AC-5, AC-6) is a property of the route and is
 * asserted against the running API in the emulator suite, where a refusal can
 * be shown to have persisted nothing.
 */

const SENDER = 'noreply@company.com';
const RETURN_PATH = 'bounces@company.com';

const guard = (configured: string[] = []) =>
  new ProtectedAccounts({ configured, sender: SENDER, returnPathGroup: RETURN_PATH });

describe('AC-2: the notification path is protected without being configured', () => {
  it('protects the relay sender and the Return-Path group by default', () => {
    // Nothing configured. The system still cannot be made to delete the account
    // that sends every welcome letter.
    const accounts = guard();

    expect(accounts.isProtected(SENDER)).toBe(true);
    expect(accounts.isProtected(RETURN_PATH)).toBe(true);
  });

  it('keeps them protected when a tenant configures its own list', () => {
    // Configured entries ADD to the defaults. A tenant listing only its
    // break-glass accounts must not thereby unprotect the sender.
    const accounts = guard(['breakglass@company.com']);

    expect(accounts.isProtected(SENDER)).toBe(true);
    expect(accounts.isProtected('breakglass@company.com')).toBe(true);
  });

  it('protects nothing extra when the relay is not wired yet', () => {
    // A deployment that has not configured the relay (REQ-028) has no sender to
    // protect, and must not end up protecting the empty string.
    const accounts = new ProtectedAccounts({
      configured: [],
      sender: undefined,
      returnPathGroup: undefined,
    });

    expect(accounts.list()).toEqual([]);
    expect(accounts.isProtected('')).toBe(false);
    expect(accounts.isProtected('anyone@company.com')).toBe(false);
  });

  it('derives the defaults from the sender and return path, and nothing else', () => {
    expect(defaultProtectedAccounts(SENDER, RETURN_PATH)).toEqual([SENDER, RETURN_PATH]);
    expect(defaultProtectedAccounts(undefined, undefined)).toEqual([]);
  });
});

describe('AC-3: the list is configuration', () => {
  it('protects exactly what configuration names, with no compiled-in tenant accounts', () => {
    const accounts = guard(['breakglass@company.com', 'audit-bot@company.com']);

    expect(accounts.list()).toEqual([
      'audit-bot@company.com',
      'bounces@company.com',
      'breakglass@company.com',
      'noreply@company.com',
    ]);
  });

  it('lets a tenant protect an account this codebase has never heard of', () => {
    // The point of configuration: no release is needed to protect something.
    expect(guard(['some-tenant-specific-thing@company.com']).isProtected(
      'some-tenant-specific-thing@company.com',
    )).toBe(true);
  });
});

describe('AC-4: matching covers the ways one mailbox can be addressed', () => {
  const accounts = guard(['Ada.Lovelace@Company.com']);

  it('matches regardless of case', () => {
    for (const form of [
      'ada.lovelace@company.com',
      'ADA.LOVELACE@COMPANY.COM',
      'Ada.Lovelace@Company.com',
    ]) {
      expect(accounts.isProtected(form)).toBe(true);
    }
  });

  it('matches through a plus tag, which reaches the same mailbox', () => {
    expect(accounts.isProtected('ada.lovelace+offboard@company.com')).toBe(true);
  });

  it('matches through dotted and undotted local parts', () => {
    expect(accounts.isProtected('adalovelace@company.com')).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(accounts.isProtected('  ada.lovelace@company.com  ')).toBe(true);
  });

  it('does not match a different mailbox at the same domain', () => {
    // The control. Without it every assertion above would hold for a matcher
    // that returned true for everything.
    expect(accounts.isProtected('grace.hopper@company.com')).toBe(false);
  });

  it('does not match the same local part at a different domain', () => {
    // Two domains are two tenants. Normalising the domain away would protect
    // accounts this deployment has no business protecting.
    expect(accounts.isProtected('ada.lovelace@other-company.com')).toBe(false);
  });
});

describe('the refusal is typed, so a caller can branch on it', () => {
  it('throws ProtectedAccountError naming the account and the phase', () => {
    const err = (() => {
      try {
        guard().assertNotProtected(SENDER, 'delete');
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ProtectedAccountError);
    expect(err).toMatchObject({
      code: 'protected_account',
      protectedAccount: SENDER,
      attemptedPhase: 'delete',
    });
    expect((err as Error).message).toContain(SENDER);
  });

  it('permits an unprotected target', () => {
    expect(() => guard().assertNotProtected('grace.hopper@company.com', 'delete')).not.toThrow();
  });

  it('normalises the account it reports, so the audit record is comparable', () => {
    const err = (() => {
      try {
        guard().assertNotProtected('  NOREPLY@COMPANY.COM ', 'update');
        return null;
      } catch (e) {
        return e as ProtectedAccountError;
      }
    })();

    expect(err!.protectedAccount).toBe(SENDER);
  });
});
