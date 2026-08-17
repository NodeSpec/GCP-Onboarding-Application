import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIRECTORY_SCOPES, DirectoryClient } from './directoryClient.js';

/**
 * TC-REQ-005-9: Workspace ADMIN role assignment is unreachable through any
 * phase.
 *
 * This is the sharpest of phase 3's criteria and the only one no behavioural
 * test can reach, because the failure mode is a capability that exists rather
 * than an action that happens. A service account able to call roleAssignments
 * can grant itself Super Admin, at which point every other boundary in this
 * system is decoration. The customer refused Domain-Wide Delegation precisely
 * to keep the blast radius small; acquiring admin-role management as a side
 * effect of routine attribute updates would undo that without anyone deciding
 * to.
 *
 * So it is checked three ways, none of which can be satisfied by accident:
 * the scope is absent from the requested set, the API surface is absent from
 * the client, and neither appears anywhere in the source or the IaC.
 *
 * Comments are stripped before scanning. The requirement, this file, and the
 * phase handler all explain the prohibition in prose that necessarily names
 * the forbidden thing; scanning comments would flag the code that honours the
 * rule and teach everyone to stop writing the explanation.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * `.nodespec` holds the specification and the generated requirement and test
 * documents. The criterion covers the codebase and the IaC; the requirement
 * text is neither, and it necessarily names the thing it prohibits in order to
 * prohibit it. Scanning it would flag the document that records the decision.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.nodespec']);
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const IAC_EXTENSIONS = ['.tf', '.tfvars', '.yaml', '.yml', '.json'];

interface SourceFile {
  path: string;
  text: string;
}

/** This file, which necessarily contains every pattern it forbids. */
const SELF = join('services', 'worker', 'src', 'workspace', 'noAdminRoles.test.ts');

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
    .filter(
      (p) =>
        extensions.some((e) => p.endsWith(e)) ||
        extraNames.some((n) => p.split(sep).pop()!.startsWith(n)),
    )
    .map((path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') }));
}

const codeFiles = load(CODE_EXTENSIONS)
  .filter((f) => f.path !== SELF)
  .map((f) => ({ path: f.path, text: stripComments(f.text, f.path) }));

const iacFiles = load(IAC_EXTENSIONS, ['Dockerfile'])
  // package-lock and friends are dependency manifests, not this system's
  // configuration, and they name every API of every transitive package.
  .filter((f) => !f.path.endsWith('package-lock.json') && !f.path.includes('node_modules'))
  .map((f) => ({ path: f.path, text: stripComments(f.text, f.path) }));

const allScanned = [...codeFiles, ...iacFiles];

function offendingFiles(files: SourceFile[], pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f.text)).map((f) => f.path);
}

/**
 * A scan that matches nothing passes for two very different reasons: the
 * repository is clean, or the scan never reached it. This makes the second
 * one fail loudly.
 */
describe('the scan actually reaches the source and the configuration', () => {
  it('discovers the application source', () => {
    expect(codeFiles.length).toBeGreaterThanOrEqual(15);
    expect(codeFiles.map((f) => f.path)).toContain(
      join('services', 'worker', 'src', 'phases', 'update.ts'),
    );
  });

  it('finds the constructs it is looking for when they ARE present', () => {
    // The positive control. The same matcher, run against text that does
    // contain the forbidden calls, must flag it. Without this, a typo in the
    // pattern would make every assertion below pass on nothing.
    const planted: SourceFile[] = [
      { path: 'planted.ts', text: 'api.roleAssignments.insert({ requestBody: {} })' },
      { path: 'planted.tf', text: 'https://www.googleapis.com/auth/admin.directory.rolemanagement' },
    ];

    expect(offendingFiles(planted, /roleAssignments/)).toEqual(['planted.ts']);
    expect(offendingFiles(planted, /admin\.directory\.rolemanagement/)).toEqual(['planted.tf']);
  });
});

describe('AC-9: no admin-role management anywhere in the repository', () => {
  it.each([
    // The mechanism, not the word. Naming the API in a test that asserts the
    // field is REFUSED is the compliant case, and a scan that flagged it would
    // teach everyone to stop writing that test.
    ['the roleAssignments API', /\broleAssignments\s*[.[]|['"]roleAssignments['"]\s*:/],
    ['the roles API', /\bapi\.roles\b|\broles\.(insert|patch|update|delete)\b/],
    ['the privileges API', /\bprivileges\.list\b/],
    ['the role management scope', /admin\.directory\.rolemanagement/],
  ])('makes no reference to %s', (_label, pattern) => {
    expect(offendingFiles(allScanned, pattern)).toEqual([]);
  });

  it('requests no role-management scope on the Directory client', () => {
    // Asserted against the exported constant, not the file text, so the check
    // holds against the value actually handed to GoogleAuth.
    for (const scope of DIRECTORY_SCOPES) {
      expect(scope).not.toContain('rolemanagement');
    }
    expect(DIRECTORY_SCOPES).toHaveLength(5);
  });

  it('requests exactly the five scopes the application consumes', () => {
    // Pinned exactly, and the pin has already done its job once: adding the
    // data-transfer scope for phase 4 failed this test, which is what makes a
    // new scope a decision somebody takes rather than something that arrives
    // with a feature.
    expect([...DIRECTORY_SCOPES]).toEqual([
      'https://www.googleapis.com/auth/admin.directory.user',
      'https://www.googleapis.com/auth/admin.directory.group.member',
      'https://www.googleapis.com/auth/admin.directory.group.readonly',
      'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
      'https://www.googleapis.com/auth/admin.datatransfer',
    ]);
  });

  it('exposes no role-assignment method on the Directory client', () => {
    // The surface an author would reach for. The guarantee is that no such
    // handle exists to reach, which a scan of call sites alone cannot say.
    const surface = Object.getOwnPropertyNames(DirectoryClient.prototype);

    expect(surface.filter((name) => /role|privilege|admin/i.test(name))).toEqual([]);
    // The methods that SHOULD exist, so this is not passing on a typo.
    expect(surface).toContain('patchUser');
    expect(surface).toContain('addMember');
  });

  it('registers no phase step that sounds like admin-role management', () => {
    // Step names are the operator-facing vocabulary of this system. A step
    // called 'grant-admin-role' would be the first sign someone tried.
    const phaseFiles = codeFiles.filter(
      (f) =>
        f.path.includes(join('services', 'worker', 'src', 'phases')) && !f.path.includes('.test.'),
    );

    expect(phaseFiles.length).toBeGreaterThan(0);
    expect(offendingFiles(phaseFiles, /name:\s*'[^']*(admin|role-assign|privilege)[^']*'/)).toEqual(
      [],
    );
  });
});
