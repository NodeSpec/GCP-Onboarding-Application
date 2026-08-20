import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AdminRoleNotGrantedError,
  DIRECTORY_SCOPES,
  DirectoryClient,
  classify,
} from './directoryClient.js';

/**
 * TC-REQ-008-1 through TC-REQ-008-7.
 *
 * The customer's constraint is that Workspace access must not use Domain-Wide
 * Delegation. That is not a behaviour a running test can observe, because the
 * wrong design also works: a delegated client returns the same successful
 * responses. It is a property of the source, so it is checked against the
 * source, and it keeps holding after everyone who remembers the constraint has
 * moved on.
 *
 * The checks target the MECHANISM, not the words. The phrase "Domain-Wide
 * Delegation" appears in comments and documentation stating that it is
 * prohibited, so a scan for the phrase would flag the very code that honours
 * the rule. What is scanned for instead is the specific set of constructs that
 * would implement delegation, impersonation, or key-file authentication.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const IAC_EXTENSIONS = ['.tf', '.tfvars', '.yaml', '.yml'];

interface SourceFile {
  path: string;
  text: string;
}

/**
 * The files that assert these patterns are ABSENT, and therefore necessarily
 * contain them.
 *
 * This file is the obvious one. infra/infra.test.ts is the other: REQ-027 AC-5
 * requires the deployment to configure no Domain-Wide Delegation, so it asserts
 * that the Terraform contains no impersonation — and to do that it has to name
 * the thing.
 *
 * The list is exact paths, not a `*.test.ts` exclusion. Excluding tests
 * wholesale would let a test construct a delegated client and never be noticed,
 * which is precisely the mechanism this scan exists to catch.
 */
const SCANNERS = [
  join('services', 'worker', 'src', 'workspace', 'noDelegation.test.ts'),
  join('infra', 'infra.test.ts'),
];

/**
 * Comments are stripped before scanning. Source that honours this constraint
 * explains that it does so, in prose that names the very mechanisms being
 * forbidden. Scanning comments would flag the compliant code and teach everyone
 * to stop writing the explanation, which is the opposite of what is wanted.
 * What matters is whether the construct is in the code path.
 */
function stripComments(text: string, path: string): string {
  if (/\.(tf|tfvars|ya?ml)$/.test(path) || path.split(sep).pop()!.startsWith('Dockerfile')) {
    return text.replace(/(^|\s)#.*$/gm, '$1');
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function load(extensions: string[], extraNames: string[] = []): SourceFile[] {
  return walk(REPO_ROOT)
    .filter((p) => extensions.some((e) => p.endsWith(e)) || extraNames.some((n) => p.split(sep).pop()!.startsWith(n)))
    .map((path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') }));
}

/** Raw text, comments intact. Used where the check is about what the file says. */
const rawCodeFiles = load(CODE_EXTENSIONS);

const codeFiles = rawCodeFiles
  .filter((f) => !SCANNERS.includes(f.path))
  .map((f) => ({ path: f.path, text: stripComments(f.text, f.path) }));
const iacFiles = load(IAC_EXTENSIONS, ['Dockerfile']).map((f) => ({
  path: f.path,
  text: stripComments(f.text, f.path),
}));
const allScanned = [...codeFiles, ...iacFiles];

/**
 * A repository scan that matches nothing passes for two very different
 * reasons: the repository is clean, or the scan is broken. This guard makes
 * the second one fail.
 */
describe('the scan actually reaches the source', () => {
  it('discovers the application source files', () => {
    expect(codeFiles.length).toBeGreaterThanOrEqual(15);
    const paths = codeFiles.map((f) => f.path);
    expect(paths).toContain(join('services', 'worker', 'src', 'workspace', 'directoryClient.ts'));
    expect(paths).toContain(join('services', 'api', 'src', 'index.ts'));
  });

  it('discovers the infrastructure as code', () => {
    // AC-3 covers code "or IaC", and until the Terraform existed that half of
    // the criterion was passing over an empty set — a scan of nothing finds
    // nothing. This guard makes the IaC half fail if the configuration ever
    // stops being scanned, rather than quietly reverting to vacuous.
    const terraform = iacFiles.filter((f) => f.path.endsWith('.tf'));
    expect(terraform.length).toBeGreaterThanOrEqual(5);
    expect(terraform.map((f) => f.path)).toContain(join('infra', 'cloudrun.tf'));
  });
});

function offendingFiles(files: SourceFile[], pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f.text)).map((f) => f.path);
}

describe('AC-1: the Directory client is built from Application Default Credentials', () => {
  const directorySource = codeFiles.find((f) => f.path.endsWith(join('workspace', 'directoryClient.ts')))!;

  it('constructs GoogleAuth with scopes only', () => {
    expect(directorySource.text).toMatch(/new GoogleAuth\(\{\s*scopes:/);
  });

  it('passes no impersonation subject anywhere an auth client is constructed', () => {
    // `subject` is a legitimate identifier elsewhere: the IAP assertion's sub
    // claim is called subject. What must not exist is a subject passed into an
    // auth client, which is how delegation is configured.
    const authFiles = codeFiles.filter((f) => /GoogleAuth|google\.auth|new JWT\(/.test(f.text));
    expect(authFiles.length).toBeGreaterThan(0);
    expect(offendingFiles(authFiles, /\bsubject\s*:/)).toEqual([]);
  });
});

describe('AC-2: no service-account key file is referenced, mounted, or read', () => {
  it.each([
    ['a keyFile or keyFilename option', /\bkeyFile(name)?\s*[:=]/],
    ['the GOOGLE_APPLICATION_CREDENTIALS variable', /GOOGLE_APPLICATION_CREDENTIALS/],
    ['an inlined private key', /private_key|BEGIN [A-Z ]*PRIVATE KEY/],
    ['service-account key material', /"type"\s*:\s*"service_account"|client_email|private_key_id/],
  ])('contains no %s', (_label, pattern) => {
    expect(offendingFiles(allScanned, pattern)).toEqual([]);
  });
});

describe('AC-3: no delegation or impersonation configuration exists in code or IaC', () => {
  it.each([
    ['impersonation', /\bimpersonat/i],
    ['a delegation call or delegated credential', /setDelegate|delegated_?credential|delegate_?to\b/i],
    ['an OAuth client-id scope authorization', /client[_-]?id.{0,40}scope|scope.{0,40}client[_-]?id/i],
  ])('configures no %s', (_label, pattern) => {
    expect(offendingFiles(allScanned, pattern)).toEqual([]);
  });
});

describe('AC-4: every requested scope has a named consumer', () => {
  /**
   * The scope-to-consumer map. A scope is only defensible if something actually
   * needs it, so each one is listed here against the methods that use it. Add a
   * scope without a consumer and this test fails, which is the point: an unused
   * scope is a standing privilege nobody is accountable for.
   */
  const CONSUMERS: Record<string, string[]> = {
    'https://www.googleapis.com/auth/admin.directory.user': [
      'getUser',
      'insertUser',
      'updateUser',
      'setSuspended',
      'deleteUser',
      'searchUsers',
    ],
    // The tokens endpoints live behind their own scope, not the user scope,
    // and behind their own Admin console privilege (Security > User Security
    // Management). Listing revokeTokens under the user scope was a claim the
    // live API refused with a 403 on the first real offboarding, at the
    // revoke-access step.
    'https://www.googleapis.com/auth/admin.directory.user.security': ['revokeTokens'],
    'https://www.googleapis.com/auth/admin.directory.group.member': [
      'hasMember',
      'addMember',
      'removeMember',
      'listMemberships',
    ],
    'https://www.googleapis.com/auth/admin.directory.group.readonly': ['listGroups'],
    'https://www.googleapis.com/auth/admin.directory.orgunit.readonly': ['listOrgUnits'],
    // Phase 4 hands a leaver's Drive to a named successor before the account is
    // deleted, which is a separate API and therefore a separate scope
    // (REQ-006 AC-8).
    'https://www.googleapis.com/auth/admin.datatransfer': [
      'driveApplicationId',
      'findDriveTransfer',
      'startDriveTransfer',
      'driveTransferStatus',
    ],
  };

  it('enumerates the scopes in exactly one place', () => {
    const declaringFiles = offendingFiles(codeFiles, /googleapis\.com\/auth\/admin\.directory/).filter(
      (p) => !p.endsWith('.test.ts'),
    );
    expect(declaringFiles).toEqual([join('services', 'worker', 'src', 'workspace', 'directoryClient.ts')]);
  });

  it('has a consumer entry for every declared scope, and no entry for an undeclared one', () => {
    expect([...Object.keys(CONSUMERS)].sort()).toEqual([...DIRECTORY_SCOPES].sort());
  });

  it('names a real method for every scope', () => {
    for (const [scope, methods] of Object.entries(CONSUMERS)) {
      expect(methods.length, `${scope} has no consumer`).toBeGreaterThan(0);
      for (const method of methods) {
        expect(
          typeof (DirectoryClient.prototype as unknown as Record<string, unknown>)[method],
          `${method} named as a consumer of ${scope} does not exist`,
        ).toBe('function');
      }
    }
  });

  it('requests no scope granting write access to groups or org units', () => {
    // The phases add and remove members, which the group.member scope covers.
    // A broader group or orgunit write scope would let the worker restructure
    // the domain, which nothing in the application needs.
    for (const scope of DIRECTORY_SCOPES) {
      expect(scope).not.toMatch(/admin\.directory\.group$/);
      expect(scope).not.toMatch(/admin\.directory\.orgunit$/);
    }
  });
});

describe('AC-5: a 403 surfaces a typed error naming the missing privilege', () => {
  it('classifies 403 as a permission problem rather than a retryable failure', () => {
    expect(classify(403)).toBe('permission');
  });

  it('throws AdminRoleNotGrantedError through the real call path', async () => {
    const client = new DirectoryClient({ customerId: 'my_customer' });
    const failing = client.call('insertUser', async () => {
      throw { code: 403, message: 'Not Authorized to access this resource/api' };
    });

    await expect(failing).rejects.toBeInstanceOf(AdminRoleNotGrantedError);
    await expect(failing).rejects.toMatchObject({ errorClass: 'permission', status: 403, operation: 'insertUser' });
  });

  it('names the admin role and where to fix it, not a generic API failure', async () => {
    const client = new DirectoryClient({ customerId: 'my_customer' });
    const err = await client
      .call('addMember', async () => {
        throw { code: 403, message: 'Not Authorized' };
      })
      .catch((e: Error) => e);

    expect(err.message).toContain('admin role');
    expect(err.message).toContain('Admin console');
    expect(err.message).toContain('addMember');
  });

  it('does not retry a permission failure', async () => {
    const client = new DirectoryClient({ customerId: 'my_customer' });
    let attempts = 0;
    await client
      .call('getUser', async () => {
        attempts += 1;
        throw { code: 403, message: 'Not Authorized' };
      })
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });
});

describe('AC-6: the Directory client is the single construction site', () => {
  it.each([
    ['a Google auth client', /new GoogleAuth\(/],
    ['a Directory API client', /google\.admin\(/],
  ])('builds %s in no file other than the Directory client', (_label, pattern) => {
    expect(offendingFiles(codeFiles, pattern)).toEqual([
      join('services', 'worker', 'src', 'workspace', 'directoryClient.ts'),
    ]);
  });

  it('leaves phase handlers with no Workspace client construction of their own', () => {
    // Handlers only. A phase test may legitimately import a googleapis type to
    // describe the shapes it fakes; it is not a code path that reaches
    // Workspace.
    const phaseFiles = codeFiles.filter(
      (f) => f.path.includes(join('services', 'worker', 'src', 'phases')) && !f.path.endsWith('.test.ts'),
    );
    expect(phaseFiles.length).toBeGreaterThan(0);
    expect(offendingFiles(phaseFiles, /new GoogleAuth\(|google\.admin\(|googleapis/)).toEqual([]);
  });
});

describe('AC-7: the Directory API is reachable only from the worker', () => {
  const apiFiles = codeFiles.filter((f) => f.path.startsWith(join('services', 'api', 'src')));

  it('has API service sources to check', () => {
    expect(apiFiles.length).toBeGreaterThan(0);
  });

  it.each([
    ['the googleapis client', /googleapis/],
    ['a Google auth client', /GoogleAuth/],
    ['the Directory client', /DirectoryClient/],
    ['a Workspace admin scope', /admin\.directory/],
  ])('contains no reference to %s in the API service', (_label, pattern) => {
    expect(offendingFiles(apiFiles, pattern)).toEqual([]);
  });
});
