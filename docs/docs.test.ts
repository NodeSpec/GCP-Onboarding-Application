import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The documentation set (REQ-015), plus the two documents other requirements
 * own the content of: REQ-027 AC-7 and REQ-031 AC-7.
 *
 * A test cannot read a document and judge whether it is any good. What it can
 * do is hold the set together: that every required document exists at the path
 * the requirement names, states which version of the system it describes, and
 * actually covers the topics it was written to cover. The failure this guards
 * against is mundane and common, which is a document that quietly stops being
 * updated, or one that is renamed and leaves every cross-reference pointing at
 * nothing.
 *
 * REQ-015 AC-7 is the real proof and is not here: an engineer new to the
 * repository reaching a working, IAP-protected deployment following only these
 * documents. That is a person doing it, once, against a real project.
 */

const DOCS = dirname(fileURLToPath(import.meta.url));
const REPO = join(DOCS, '..');

const REQUIRED = [
  'workspace-admin-setup.md',
  'deployment.md',
  'approval-policy.md',
  'runbook.md',
  'architecture.md',
];

const read = (name: string) => readFileSync(join(DOCS, name), 'utf8');

// ============================================================== REQ-015

describe('REQ-015 AC-1: the set exists, and each document says what it describes', () => {
  it.each(REQUIRED)('%s exists at its documented path', (name) => {
    expect(existsSync(join(DOCS, name)), `docs/${name} is missing`).toBe(true);
  });

  it.each(REQUIRED)('%s states the system version it describes', (name) => {
    // Without this a reader has no way to tell whether a document describes
    // what is deployed or what was deployed two releases ago.
    expect(read(name)).toMatch(/Applies to: lifecycle console \d+\.\d+\.\d+/);
  });

  it('states a version that matches the repository', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      version: string;
    };

    for (const name of REQUIRED) {
      expect(read(name), `docs/${name} names a different version`).toContain(
        `Applies to: lifecycle console ${pkg.version}`,
      );
    }
  });
});

describe('REQ-015 AC-2: the deployment guide covers the whole path to a running system', () => {
  const doc = () => read('deployment.md');

  it.each([
    ['project prerequisites', /project \*\*number\*\*|project number/i],
    ['billing', /billing/i],
    ['API enablement', /services enable|cloudresourcemanager/i],
    ['the Terraform apply', /terraform apply/],
    ['the IAP OAuth brand', /oauth[- ]?brand|google_iap_brand/i],
    ['the IAP client', /iap_client_id|google_iap_client/],
    ['granting operator access', /iap\.httpsResourceAccessor|operator group/i],
  ])('covers %s', (_label, pattern) => {
    expect(doc()).toMatch(pattern);
  });

  it('says how access is granted and revoked, since that is the part done repeatedly', () => {
    // Once deployed, this is the only step anyone performs again. A guide that
    // covers the apply and not this is a guide read once.
    expect(doc()).toMatch(/add them to the group|memberships add/i);
    expect(doc()).toMatch(/remove them|revocation/i);
  });

  it('warns that the audit retention lock cannot be undone', () => {
    // Applying the default into a scratch project pins its logs for years.
    // Someone finding that out afterwards has no remedy.
    expect(doc()).toMatch(/irreversible/i);
    expect(doc()).toContain('audit_bucket_locked');
  });
});

describe('REQ-015 AC-3: the approval policy document covers every knob and both extremes', () => {
  const doc = () => read('approval-policy.md');

  it.each([
    ['requiresApproval', /requiresApproval/],
    ['approverRole', /approverRole/],
    ['expiryHours', /expiryHours/],
  ])('documents the %s knob', (_label, pattern) => {
    expect(doc()).toMatch(pattern);
  });

  it('gives a fully automated example', () => {
    expect(doc()).toMatch(/fully automated/i);
  });

  it('gives a fully two-party example', () => {
    expect(doc()).toMatch(/fully two-party/i);
  });

  it('says which knob cannot be turned off, and why', () => {
    // The mandatory floor on delete-user. A reader who configures a policy
    // without knowing this will write one that appears to disable it.
    expect(doc()).toMatch(/delete-user/);
    expect(doc()).toMatch(/no undo|cannot be undone|nobody can take back/i);
  });

  it('says the policy is snapshotted, so an edit does not reach in-flight requests', () => {
    expect(doc()).toMatch(/snapshot/i);
  });
});

describe('REQ-015 AC-4: the runbook covers diagnosis, resumption, cancellation and error classes', () => {
  const doc = () => read('runbook.md');

  it('covers diagnosing a stuck request', () => {
    expect(doc()).toMatch(/stuck request/i);
    expect(doc()).toMatch(/awaiting_approval/);
    expect(doc()).toMatch(/step timeline/i);
  });

  it('covers resuming one', () => {
    expect(doc()).toMatch(/resuming a request/i);
  });

  it('covers cancellation, and says a compensating unsuspend is dispatched', () => {
    // The distinction that matters on call: 'compensating' means the account is
    // being put back and is not yet usable. Reporting it as cancelled tells
    // somebody the account works when it does not.
    expect(doc()).toMatch(/cancelling a request/i);
    expect(doc()).toMatch(/compensating/);
    expect(doc()).toMatch(/unsuspend/i);
  });

  it.each([
    ['retryable', /`retryable`/],
    ['terminal', /`terminal`/],
    ['validation', /`validation`/],
    ['permission', /`permission`/],
  ])('gives the meaning of the %s error class', (_label, pattern) => {
    expect(doc()).toMatch(pattern);
  });

  it('says what to do about each class, not just what it is called', () => {
    expect(doc()).toMatch(/Retrying will not help|Raise a corrected request/i);
  });
});

describe('REQ-015 AC-5: the architecture document names components, boundaries and stores', () => {
  const doc = () => read('architecture.md');

  it.each([
    ['the console', /Operator Console UI/i],
    ['the API service', /Lifecycle API Service/i],
    ['the worker', /Lifecycle Step Executor/i],
    ['Cloud Tasks', /Cloud Tasks/],
    ['Firestore', /Firestore/],
    ['the audit log bucket', /audit bucket|Cloud Logging/i],
    ['Secret Manager', /Secret Manager/],
    ['the load balancer and IAP', /load balancer/i],
    ['Workspace', /Google Workspace/],
    ['email delivery', /SMTP relay/i],
  ])('names %s', (_label, pattern) => {
    expect(doc()).toMatch(pattern);
  });

  it('names the trust boundaries', () => {
    expect(doc()).toMatch(/trust boundaries/i);
    expect(doc()).toMatch(/IAP perimeter/i);
  });

  it('says which apparent boundary is NOT one', () => {
    // Firestore. Someone will otherwise assume the two services are separated
    // there and build on a control that does not exist.
    expect(doc()).toMatch(/NOT a boundary|not a boundary/);
    expect(doc()).toMatch(/database-scoped/i);
  });

  it('says what each store holds', () => {
    for (const collection of [
      'lifecycleRequests',
      'auditEvents',
      'credentialHandoffs',
      'roleBindings',
      'approvalPolicy',
    ]) {
      expect(doc(), `no section for ${collection}`).toContain(collection);
    }
  });

  it('says the credential record holds ciphertext rather than a hash, and why', () => {
    // The criterion asks for the reasoning, not the fact. A hash is the right
    // answer for a password the system verifies and the wrong one for a
    // password it hands to a human once.
    expect(doc()).toMatch(/ciphertext/i);
    expect(doc()).toMatch(/[Nn]ot as a hash|rather than a hash/);
    expect(doc()).toMatch(/hands it to a human|read the actual characters/i);
    // And the compensating controls, without which reversible encryption here
    // would not be defensible.
    expect(doc()).toMatch(/exactly once/i);
    expect(doc()).toMatch(/TTL/);
  });
});

describe('REQ-015 AC-6: the scope reading of "roles" is written down for the customer', () => {
  const doc = () => read('architecture.md');

  it('is marked as something for the customer to confirm or correct', () => {
    expect(doc()).toMatch(/confirm or correct/i);
  });

  it('says what is in scope: group membership and role-describing attributes', () => {
    expect(doc()).toMatch(/group membership/i);
    expect(doc()).toMatch(/job title|title, department/i);
  });

  it('says Workspace admin-role assignment is excluded', () => {
    expect(doc()).toMatch(/admin-role assignment/i);
    expect(doc()).toMatch(/[Oo]ut of scope/);
  });

  it('says WHY it is excluded, in terms of the privilege', () => {
    // "Not implemented" and "deliberately excluded because it would let the
    // service account mint a Super Admin" are different statements, and only
    // the second lets the customer make a decision about it.
    expect(doc()).toMatch(/role-management privilege/i);
    expect(doc()).toMatch(/Super Admin/i);
  });
});

// ============================================================== REQ-027

describe('REQ-027 AC-7: the Workspace setup is reproducible on a clean tenant', () => {
  const doc = () => read('workspace-admin-setup.md');

  it('gives the exact console navigation path for the role assignment', () => {
    // The criterion names this path specifically. It is not discoverable: the
    // option only appears on a role carrying no privilege a service account
    // cannot hold.
    expect(doc()).toMatch(/Account > Admin roles/);
    expect(doc()).toMatch(/Assign service accounts/);
  });

  it('enumerates the privilege list', () => {
    expect(doc()).toMatch(/\*\*Users\*\*/);
    expect(doc()).toMatch(/\*\*Groups\*\*/);
    expect(doc()).toMatch(/\*\*Organizational Units\*\*/);
  });

  it('says the role carries no role-management privilege, and why that matters', () => {
    expect(doc()).toMatch(/[Nn]o role-management privilege/);
    expect(doc()).toMatch(/to itself/i);
    expect(doc()).toMatch(/Super Admin/i);
  });

  it('says to confirm Domain-Wide Delegation is absent', () => {
    expect(doc()).toMatch(/Domain[- ]Wide Delegation/i);
    expect(doc()).toMatch(/API controls/);
    expect(doc()).toMatch(/no entry/i);
  });

  it('gives a verification step that proves the grant is live', () => {
    expect(doc()).toMatch(/Verify the grant is live|verify the grant/i);
    expect(doc()).toMatch(/read-only|users\.list|picker/i);
  });

  it('says to confirm app passwords are available before anything is built on them', () => {
    // If the tenant has them disabled the whole relay design is void, and
    // finding that out after the deployment is the expensive order to do it in.
    expect(doc()).toMatch(/app password/i);
    expect(doc()).toMatch(/2-step verification/i);
  });
});

// ============================================================== REQ-031

describe('REQ-031 AC-7: protected accounts are documented with how to amend them', () => {
  const doc = () => read('runbook.md');

  it('documents the list and what is on it by default', () => {
    expect(doc()).toMatch(/[Pp]rotected accounts/);
    expect(doc()).toMatch(/SMTP_SENDER/);
    expect(doc()).toMatch(/SMTP_RETURN_PATH/);
  });

  it('says how to amend it, by the configuration name that actually does it', () => {
    expect(doc()).toContain('PROTECTED_ACCOUNTS');
    expect(doc()).toMatch(/without a code release|changes without a code release/i);
  });

  it('warns that an over-broad list silently blocks legitimate offboarding', () => {
    // The criterion asks for this warning by name, and it is the failure mode
    // nobody anticipates: the refusal looks like a bug rather than a policy.
    expect(doc()).toMatch(/over-broad/i);
    expect(doc()).toMatch(/blocks legitimate offboarding|legitimate offboarding/i);
  });

  it('says an admin is refused too', () => {
    expect(doc()).toMatch(/admin is refused/i);
  });
});

// =============================================================== house style

describe('house style', () => {
  /** Everything a reader outside the team sees, not just docs/. */
  const PROSE = [
    ...REQUIRED.map((name) => join(DOCS, name)),
    join(DOCS, 'testing.md'),
    join(REPO, 'README.md'),
    join(REPO, 'ARCHITECTURE.md'),
  ];

  it.each(PROSE)('%s uses no em dashes', (path) => {
    // A stated constraint on the documentation, and the kind of thing that
    // drifts one paragraph at a time without something checking.
    expect(readFileSync(path, 'utf8')).not.toContain('—');
  });

  it.each(PROSE)('%s does not name the customer by their former placeholder name', (path) => {
    expect(readFileSync(path, 'utf8').toLowerCase()).not.toContain('dark wolf');
  });
});

describe('the README is a usable entry point for a live deployment', () => {
  const readme = () => readFileSync(join(REPO, 'README.md'), 'utf8');

  it('covers the build, the apply, the Workspace side and the secrets', () => {
    // The four things that have to happen in order, and the order is the part
    // people get wrong: the Workspace grant needs a service account that only
    // exists after the apply.
    expect(readme()).toMatch(/Build and push the images/i);
    expect(readme()).toMatch(/terraform apply/);
    expect(readme()).toMatch(/Do the Workspace side/i);
    expect(readme()).toMatch(/Populate the secrets/i);
  });

  it('gives a live test walkthrough rather than only a deployment recipe', () => {
    expect(readme()).toMatch(/[Ll]ive test walkthrough/);
    // The check that is easy to assume and cheap to make: somebody outside the
    // operator group being turned away at the perimeter.
    expect(readme()).toMatch(/outside the operator group is refused/i);
    // And the one whose success is the finding.
    expect(readme()).toMatch(/should FAIL|A 200 is a finding/);
  });

  it('warns about the irreversible audit retention lock', () => {
    expect(readme()).toMatch(/IRREVERSIBLE|irreversible/);
    expect(readme()).toContain('audit_bucket_locked');
  });

  it('lists the configuration the services actually read', () => {
    // Added since the table was written, and the kind of thing that silently
    // stops being listed.
    for (const variable of [
      'BOOTSTRAP_ADMINS',
      'PROTECTED_ACCOUNTS',
      'SMTP_RETURN_PATH',
      'AUDIT_LOG_NAME',
      'AUDIT_LOG_VIEW',
    ]) {
      expect(readme(), `${variable} is not documented`).toContain(variable);
    }
  });
});
