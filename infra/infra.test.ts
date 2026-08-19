import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allBlocks,
  attr,
  blockNamed,
  infraFiles,
  nested,
  resources,
  type Block,
} from './hcl.js';

/**
 * The deployment, asserted (REQ-009, REQ-014, REQ-018, REQ-020 to REQ-027).
 *
 * Many of these criteria are worded as "asserted in Terraform so an added X
 * fails the check", and that wording is the requirement, not a suggestion about
 * how to test it. "Exactly one backend service, and it has IAP enabled" is not
 * a fact about today's configuration — it is an invariant that has to survive
 * the next person adding a service in a hurry. A reviewer cannot hold it; a
 * test can.
 *
 * WHAT THIS CANNOT DO, stated plainly. `terraform validate` and `terraform
 * plan` need the provider registry and a GCP project, and neither is reachable
 * from the test environment, so REQ-009 AC-1 is not proven here. Nor is
 * anything about the DEPLOYED state: that the retention lock actually refuses a
 * shortening attempt, that an account outside the operator group is turned away
 * at the perimeter, that an expired credential document is really removed. Each
 * of those is a live-infrastructure check and is listed as one. What is proven
 * here is that the configuration DECLARES what the criteria require, which is
 * the half a repository can hold.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const BLOCKS = allBlocks();
const CONFIG = infraFiles()
  .map((f) => f.text)
  .join('\n');

/** One resource of a given type, asserting there is exactly one. */
const named = (type: string, name: string): Block => {
  const found = resources(BLOCKS, type).filter((b) => b.labels[1] === name);
  expect(found, `expected exactly one ${type}.${name}`).toHaveLength(1);
  return found[0]!;
};

/** One `variable` / `output` / other non-resource block, by name. */
const declared = (type: string, name: string): Block => {
  const found = blockNamed(BLOCKS, type, name);
  expect(found, `expected exactly one ${type} "${name}"`).toHaveLength(1);
  return found[0]!;
};

// ============================================================== REQ-020

describe('REQ-020: Firestore', () => {
  const db = () => named('google_firestore_database', 'lifecycle');

  it('AC-1: is Native mode, in a location supplied as a variable', () => {
    expect(attr(db().body, 'type')).toBe('"FIRESTORE_NATIVE"');
    // The location is a decision, not a console default. Moving a Firestore
    // database means creating a new one, so this is one of the few values that
    // is effectively permanent.
    expect(attr(db().body, 'location_id')).toBe('var.firestore_location');
  });

  it('AC-2: declares a composite index for every documented query pattern', () => {
    const indexes = resources(BLOCKS, 'google_firestore_index');

    const shape = (block: Block) => ({
      collection: attr(block.body, 'collection')?.replace(/"/g, ''),
      fields: nested(block.body, 'fields').map(
        (f) => `${attr(f.body, 'field_path')?.replace(/"/g, '')}:${attr(f.body, 'order')?.replace(/"/g, '')}`,
      ),
    });

    const shapes = indexes.map(shape);
    const has = (collection: string, prefix: string[]) =>
      shapes.some(
        (s) =>
          s.collection === collection &&
          prefix.every((field, i) => s.fields[i] === field),
      );

    // Firestore refuses a composite query with no index at RUNTIME, so a
    // missing one here is not a slow list — it is a 500 the first time an
    // operator applies that filter.
    expect(has('lifecycleRequests', ['status:ASCENDING', 'createdAt:DESCENDING'])).toBe(true);
    expect(has('lifecycleRequests', ['targetUser:ASCENDING', 'createdAt:DESCENDING'])).toBe(true);
    expect(has('lifecycleRequests', ['phase:ASCENDING', 'status:ASCENDING'])).toBe(true);
    expect(has('lifecycleRequests', ['targetUser:ASCENDING', 'status:ASCENDING'])).toBe(true);
    expect(has('auditEvents', ['requestId:ASCENDING', 'timestamp:ASCENDING'])).toBe(true);

    // The approvals inbox, which orders on updatedAt rather than createdAt: an
    // approver wants the request that most recently stopped, not the one most
    // recently raised. Missing this one is a 500 on the one screen an approver
    // opens, which is how it was found.
    expect(has('lifecycleRequests', ['status:ASCENDING', 'updatedAt:DESCENDING'])).toBe(true);
  });

  it('AC-2: every paging index tie-breaks on requestId, matching the cursor the API pages with', () => {
    // The list pages on (createdAt desc, requestId desc). An index ordered on
    // createdAt alone would work until two requests shared a timestamp, and
    // then the cursor would skip or repeat a row.
    //
    // Scoped to the indexes that back a paged query, which is what the tie-break
    // is for. The approvals inbox does not page: it is one bounded read with no
    // startAfter, so a trailing requestId would be a column no query orders on.
    // Identified by ordering on createdAt, since paging and that cursor are the
    // same decision.
    const requestIndexes = resources(BLOCKS, 'google_firestore_index').filter(
      (b) => attr(b.body, 'collection') === '"lifecycleRequests"',
    );
    const fieldsOf = (b: Block) =>
      nested(b.body, 'fields').map((f) => attr(f.body, 'field_path'));

    const paging = requestIndexes.filter((b) => fieldsOf(b).includes('"createdAt"'));

    expect(paging.length).toBeGreaterThan(0);
    for (const index of paging) {
      const fields = fieldsOf(index);
      expect(fields[fields.length - 1]).toBe('"requestId"');
    }

    // And the exemption is narrow rather than a hole: an index that does not
    // page must not order on createdAt at all, or it is a paged list that
    // quietly lost its tie-break.
    for (const index of requestIndexes.filter((b) => !paging.includes(b))) {
      expect(fieldsOf(index)).not.toContain('"createdAt"');
    }
  });

  it('AC-3: puts a TTL on the credential handoff record', () => {
    const ttl = named('google_firestore_field', 'credential_ttl');

    // The last line of defence for a real person's initial password if nobody
    // ever retrieves it. Firestore performs the removal, so it happens whether
    // or not the application is running or correct.
    expect(attr(ttl.body, 'collection')).toBe('"credentialHandoffs"');
    expect(attr(ttl.body, 'field')).toBe('"expiresAt"');
    expect(nested(ttl.body, 'ttl_config')).toHaveLength(1);
  });

  it('AC-4: enables point-in-time recovery and a backup schedule, both from variables', () => {
    expect(attr(db().body, 'point_in_time_recovery_enablement')).toContain(
      'var.firestore_pitr_retention',
    );

    const backup = named('google_firestore_backup_schedule', 'daily');
    expect(attr(backup.body, 'retention')).toContain('var.firestore_backup_retention_days');
  });

  it('AC-6: ships no security rules file, and records why', () => {
    // Rules govern client SDK access, and no client SDK touches this database.
    // A rules file would appear to constrain access and constrain nothing,
    // which is worse than having none.
    const rules = readdirSync(REPO).filter((n) => n.includes('firestore.rules'));
    expect(rules).toEqual([]);
    expect(CONFIG).toMatch(/security rules[\s\S]{0,400}Admin SDK/i);
  });
});

// ============================================================== REQ-021

describe('REQ-021: Cloud Tasks', () => {
  const queue = () => named('google_cloud_tasks_queue', 'lifecycle_steps');

  it('AC-1: sets every retry parameter from a declared variable', () => {
    const retry = nested(queue().body, 'retry_config')[0]!;

    // A provider default is not a decision anyone made. A step that stops
    // retrying after five attempts because nobody chose a number is behaviour
    // no reviewer of this repository could have known about.
    expect(attr(retry.body, 'max_attempts')).toBe('var.queue_max_attempts');
    expect(attr(retry.body, 'min_backoff')).toContain('var.queue_min_backoff_seconds');
    expect(attr(retry.body, 'max_backoff')).toContain('var.queue_max_backoff_seconds');
    expect(attr(retry.body, 'max_doublings')).toBe('var.queue_max_doublings');
  });

  it('AC-2: caps dispatch below the Directory API quota', () => {
    const limits = nested(queue().body, 'rate_limits')[0]!;

    expect(attr(limits.body, 'max_dispatches_per_second')).toBe(
      'var.queue_max_dispatches_per_second',
    );
    expect(attr(limits.body, 'max_concurrent_dispatches')).toBe(
      'var.queue_max_concurrent_dispatches',
    );

    // And the defaults are actually modest. Declaring the value as a variable
    // and then defaulting it to something that outruns the quota would satisfy
    // the letter of the criterion and none of its purpose.
    const dispatches = declared('variable', 'queue_max_dispatches_per_second');
    expect(Number(attr(dispatches.body, 'default'))).toBeLessThanOrEqual(10);
  });

  it('AC-3: provisions a dedicated queue invoker identity', () => {
    const sa = named('google_service_account', 'queue_invoker');
    expect(attr(sa.body, 'account_id')).toBe('"lifecycle-queue-invoker"');
  });

  it('AC-4: mints the scheduled sweep with the worker URL as its OIDC audience', () => {
    // The dispatch path for step tasks is the application's (REQ-016); this is
    // the one task Terraform itself constructs.
    const scheduled = named('google_cloud_scheduler_job', 'audit_mirror');
    expect(scheduled.body).toContain('google_cloud_tasks_queue.lifecycle_steps.id');
    expect(CONFIG).toContain('audience            = google_cloud_run_v2_service.worker.uri');
  });

  it('AC-6: wires the queue name and worker URL from resources, not from literals', () => {
    const api = named('google_cloud_run_v2_service', 'api');
    const env = nested(api.body, 'env');

    const value = (name: string) =>
      env.find((e) => attr(e.body, 'name') === `"${name}"`)?.body ?? '';

    expect(value('TASKS_QUEUE')).toContain('google_cloud_tasks_queue.lifecycle_steps.name');
    expect(value('WORKER_BASE_URL')).toContain('google_cloud_run_v2_service.worker.uri');
  });
});

// ============================================================== REQ-022

describe('REQ-022: Secret Manager', () => {
  it('AC-1: provisions both secrets with an explicit replication policy', () => {
    const smtp = named('google_secret_manager_secret', 'smtp');
    const key = named('google_secret_manager_secret', 'credential_key');

    expect(attr(smtp.body, 'secret_id')).toBe('"notification-smtp-credentials"');
    expect(attr(key.body, 'secret_id')).toBe('"credential-encryption-key"');

    // Stated, not inherited. `auto` is what the provider would have chosen, and
    // saying so is the difference between a decision and a default.
    for (const secret of [smtp, key]) {
      expect(nested(secret.body, 'replication')).toHaveLength(1);
    }
  });

  it('AC-2: creates the secrets empty, so no value can reach Terraform state', () => {
    // A value passed through a variable is written to state in plaintext, and
    // state is a file people copy around. There is no secret VERSION resource
    // anywhere for exactly that reason.
    expect(resources(BLOCKS, 'google_secret_manager_secret_version')).toEqual([]);
    expect(CONFIG).not.toMatch(/secret_data\s*=/);
  });

  it('AC-5: records the rotation decision next to the secret it governs', () => {
    // The credential record stores the key version it was encrypted under, so
    // ciphertext keeps decrypting while that version is enabled. The drain step
    // is not enforceable in Terraform — versions are added out of band by
    // design — so what the criterion asks for is that the choice is written
    // down where someone rotating will see it.
    const secrets = readFileSync(join(HERE, 'secrets.tf'), 'utf8');
    expect(secrets).toMatch(/drain step/i);
    expect(secrets).toMatch(/key VERSION|key version/);
  });

  it('AC-6: labels each secret with its owning service and purpose', () => {
    for (const name of ['smtp', 'credential_key']) {
      const labels = named('google_secret_manager_secret', name).body;
      expect(labels).toMatch(/labels\s*=\s*\{/);
      expect(labels).toMatch(/service\s*=/);
      expect(labels).toMatch(/purpose\s*=/);
    }
  });
});

// ============================================================== REQ-023

describe('REQ-023: IAP', () => {
  it('AC-1: provisions the brand and client, and surfaces the client id as an output', () => {
    named('google_iap_brand', 'console');
    named('google_iap_client', 'console');

    const outputs = BLOCKS.filter((b) => b.type === 'output').map((b) => b.labels[0]);
    expect(outputs).toContain('iap_client_id');
  });

  it('AC-2: grants access to the operator group only', () => {
    const grants = resources(BLOCKS, 'google_iap_web_backend_service_iam_member');
    expect(grants).toHaveLength(1);

    const member = attr(grants[0]!.body, 'member') ?? '';
    // A group, so joiners and leavers are handled by group membership rather
    // than by a Terraform apply that drifts the first time someone is in a
    // hurry.
    expect(member).toContain('group:');
    expect(member).toContain('var.operator_group');
    expect(member).not.toContain('allAuthenticatedUsers');
    expect(member).not.toContain('allUsers');
    expect(member).not.toMatch(/user:/);
  });

  it('AC-3: emits the audience as an output and feeds it to the API service', () => {
    const outputs = BLOCKS.filter((b) => b.type === 'output').map((b) => b.labels[0]);
    expect(outputs).toContain('iap_audience');

    // The verifier compares this exactly. A hand-copied value that drifts from
    // the perimeter rejects every assertion and produces a console nobody can
    // sign in to, with nothing in any log saying why.
    const api = named('google_cloud_run_v2_service', 'api');
    const audience = nested(api.body, 'env').find(
      (e) => attr(e.body, 'name') === '"IAP_AUDIENCE"',
    );
    expect(audience?.body).toContain('local.iap_audience');
    expect(CONFIG).toContain('google_compute_backend_service.api.generated_id');
  });

  it('AC-4: enables IAP on the operator backend service', () => {
    const backend = named('google_compute_backend_service', 'api');
    const iap = nested(backend.body, 'iap')[0];

    expect(iap).toBeDefined();
    expect(attr(iap!.body, 'enabled')).toBe('true');
  });
});

// ============================================================== REQ-024

describe('REQ-024: load balancer', () => {
  it('AC-1: attaches a serverless NEG pointing at the API service', () => {
    const neg = named('google_compute_region_network_endpoint_group', 'api');
    expect(attr(neg.body, 'network_endpoint_type')).toBe('"SERVERLESS"');
    expect(nested(neg.body, 'cloud_run')[0]!.body).toContain(
      'google_cloud_run_v2_service.api.name',
    );

    const backend = named('google_compute_backend_service', 'api');
    expect(nested(backend.body, 'backend')[0]!.body).toContain(
      'google_compute_region_network_endpoint_group.api.id',
    );
  });

  it('AC-2 and REQ-007 AC-11: there is exactly one backend service, and it has IAP', () => {
    // The assertion the criterion asks for by name. A second backend added
    // later would be a second way in; this is what makes "every operator-facing
    // route is behind IAP" checkable rather than asserted.
    const backends = resources(BLOCKS, 'google_compute_backend_service');
    expect(backends).toHaveLength(1);

    for (const backend of backends) {
      const iap = nested(backend.body, 'iap')[0];
      expect(iap, `${backend.labels[1]} has no iap block`).toBeDefined();
      expect(attr(iap!.body, 'enabled')).toBe('true');
    }
  });

  it('AC-3: provisions a managed certificate for the supplied domain', () => {
    const cert = named('google_compute_managed_ssl_certificate', 'console');
    expect(nested(cert.body, 'managed')[0]!.body).toContain('var.domain');
  });

  it('AC-4: redirects HTTP rather than serving it', () => {
    const redirect = named('google_compute_url_map', 'redirect');
    const rule = nested(redirect.body, 'default_url_redirect')[0]!;

    expect(attr(rule.body, 'https_redirect')).toBe('true');
    // The redirect map has no default_service: nothing is served on port 80.
    expect(attr(redirect.body, 'default_service')).toBeNull();
  });

  it('AC-5: does not attach the worker to the load balancer', () => {
    // The worker has no human callers, so putting it behind IAP would add a
    // control with nothing to control. What matters is that it is not reachable
    // from outside at all.
    const negs = resources(BLOCKS, 'google_compute_region_network_endpoint_group');
    for (const neg of negs) {
      expect(neg.body).not.toContain('google_cloud_run_v2_service.worker');
    }
  });

  it('AC-6: grants run.invoker on the API service to the IAP identity alone', () => {
    const grants = resources(BLOCKS, 'google_cloud_run_v2_service_iam_member').filter((b) =>
      b.body.includes('google_cloud_run_v2_service.api.name'),
    );

    expect(grants).toHaveLength(1);
    expect(attr(grants[0]!.body, 'role')).toBe('"roles/run.invoker"');
    expect(attr(grants[0]!.body, 'member')).toContain('gcp-sa-iap.iam.gserviceaccount.com');
  });
});

// ========================================================= REQ-025 / REQ-026

describe('REQ-025 and REQ-026: the Cloud Run services', () => {
  const api = () => named('google_cloud_run_v2_service', 'api');
  const worker = () => named('google_cloud_run_v2_service', 'worker');

  it('restricts ingress on both services so no *.run.app request reaches them', () => {
    // REQ-025 AC-1, REQ-026 AC-1, and what makes the load balancer the only way
    // in — and therefore what makes IAP unavoidable rather than merely present.
    for (const service of [api(), worker()]) {
      expect(attr(service.body, 'ingress')).toBe('"INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"');
    }
  });

  it('runs each service under its own identity', () => {
    // REQ-025 AC-2, REQ-026 AC-3, REQ-009 AC-4. The separation that is real is
    // the Workspace admin role: the worker's identity holds it and the API
    // service's does not, so a compromise of the operator surface cannot mutate
    // the directory.
    const apiSa = nested(api().body, 'template')[0]!.body;
    const workerSa = nested(worker().body, 'template')[0]!.body;

    expect(attr(apiSa, 'service_account')).toContain('google_service_account.api.email');
    expect(attr(workerSa, 'service_account')).toContain('google_service_account.worker.email');
    expect(attr(apiSa, 'service_account')).not.toBe(attr(workerSa, 'service_account'));
  });

  it('scales both services to zero', () => {
    // REQ-025 AC-3, REQ-026 AC-4, REQ-009 AC-3. Also the honest shape of the
    // workload: an onboarding console is idle almost all of the time.
    for (const service of [api(), worker()]) {
      const scaling = nested(nested(service.body, 'template')[0]!.body, 'scaling')[0]!;
      expect(attr(scaling.body, 'min_instance_count')).toBe('0');
    }
  });

  it('sets timeout and concurrency explicitly on both, from variables', () => {
    // REQ-025 AC-5, REQ-026 AC-5. The worker's timeout is the load-bearing one:
    // shorter than a step's retry window turns a step that would have recovered
    // into a task failure.
    const apiTemplate = nested(api().body, 'template')[0]!.body;
    const workerTemplate = nested(worker().body, 'template')[0]!.body;

    expect(attr(apiTemplate, 'timeout')).toContain('var.api_request_timeout_seconds');
    expect(attr(apiTemplate, 'max_instance_request_concurrency')).toBe('var.api_max_concurrency');
    expect(attr(workerTemplate, 'timeout')).toContain('var.worker_request_timeout_seconds');
    expect(attr(workerTemplate, 'max_instance_request_concurrency')).toBe(
      'var.worker_max_concurrency',
    );
  });

  it('references both images by digest, enforced by the variable itself', () => {
    // REQ-025 AC-6, REQ-026 AC-6. A tag is a mutable pointer: the same state
    // would describe different running code depending on when it was applied,
    // and a rollback would have nothing exact to roll back to. The validation
    // block is what makes a tag fail at plan time rather than in review.
    for (const name of ['api_image', 'worker_image']) {
      const variable = declared('variable', name);
      const validation = nested(variable.body, 'validation')[0];
      expect(validation, `${name} has no digest validation`).toBeDefined();
      expect(validation!.body).toContain('sha256');
    }
  });

  it('REQ-026 AC-2: admits exactly two principals on the worker', () => {
    // The criterion names the check: a third principal must fail. The grants
    // come from one map literal so a caller cannot be added by appending a
    // resource elsewhere and hoping nobody re-counts.
    const set = /worker_invokers\s*=\s*\{([\s\S]*?)\n  \}/.exec(CONFIG);
    expect(set).not.toBeNull();

    const principals = [...set![1]!.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]);
    expect(principals.sort()).toEqual(['api_service', 'queue_invoker']);

    expect(set![1]).toContain('google_service_account.queue_invoker.email');
    expect(set![1]).toContain('google_service_account.api.email');

    // And nothing else grants run.invoker on the worker by another route.
    const grants = resources(BLOCKS, 'google_cloud_run_v2_service_iam_member').filter((b) =>
      b.body.includes('google_cloud_run_v2_service.worker.name'),
    );
    expect(grants).toHaveLength(1);
    expect(attr(grants[0]!.body, 'for_each')).toBe('local.worker_invokers');
  });

  it('REQ-026 AC-2: the scheduled sweep arrives through the queue, not as a third caller', () => {
    // The worker admits two identities and its /tasks routes are mounted behind
    // requireCaller('cloud-tasks'), so a scheduler calling it directly would be
    // refused even if IAM allowed it. The sweep is enqueued instead.
    const scheduler = named('google_cloud_scheduler_job', 'audit_mirror');
    expect(scheduler.body).toContain('cloudtasks.googleapis.com');
    expect(scheduler.body).not.toContain('oidc_token');

    const schedulerGrants = resources(BLOCKS, 'google_cloud_run_v2_service_iam_member').filter(
      (b) => b.body.includes('google_service_account.scheduler'),
    );
    expect(schedulerGrants).toEqual([]);
  });
});

// ============================================================== REQ-009

describe('REQ-009: serverless deployment', () => {
  it('AC-2: provisions every component the system runs on', () => {
    const present = new Set(resources(BLOCKS).map((b) => b.labels[0]));

    for (const type of [
      'google_cloud_run_v2_service',
      'google_compute_region_network_endpoint_group',
      'google_compute_backend_service',
      'google_firestore_database',
      'google_cloud_tasks_queue',
      'google_secret_manager_secret',
      'google_iap_client',
    ]) {
      expect(present, `missing ${type}`).toContain(type);
    }

    expect(resources(BLOCKS, 'google_cloud_run_v2_service')).toHaveLength(2);
  });

  it('AC-5: dispatches queue work with an OIDC token', () => {
    // The queue targets the worker, and the worker refuses a token issued to
    // anyone but the queue invoker. That second half is application code and is
    // proven by the worker's own auth tests; this asserts the identity exists
    // and is the one wired into both services' configuration.
    const api = named('google_cloud_run_v2_service', 'api');
    const invoker = nested(api.body, 'env').find(
      (e) => attr(e.body, 'name') === '"QUEUE_INVOKER_SA"',
    );
    expect(invoker?.body).toContain('google_service_account.queue_invoker.email');
  });

  it('AC-6: contains no VM, instance group, or Kubernetes cluster', () => {
    // "Serverless" is a constraint from the customer, so it is checked rather
    // than assumed. A future compute_instance would fail here.
    const forbidden = resources(BLOCKS).filter((b) =>
      /^google_(compute_instance|compute_instance_group|compute_instance_template|container_cluster|container_node_pool)/.test(
        b.labels[0] ?? '',
      ),
    );
    expect(forbidden.map((b) => b.labels.join('.'))).toEqual([]);
  });
});

// ============================================================== REQ-014

describe('REQ-014: least-privilege identities and secrets', () => {
  it('AC-1: contains no service-account key, API key, or password literal', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(REPO);

    // A downloaded key is the thing the whole no-delegation design exists to
    // avoid; ADC from the metadata server is the only credential path.
    const keyFiles = files.filter((f) => /service-account.*\.json$|.*-key\.json$/.test(f));
    expect(keyFiles.map((f) => relative(REPO, f))).toEqual([]);

    expect(resources(BLOCKS, 'google_service_account_key')).toEqual([]);
    expect(CONFIG).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
  });

  it('AC-2: passes secrets by resource name, never by value', () => {
    const worker = named('google_cloud_run_v2_service', 'worker');
    const env = nested(worker.body, 'env');

    // Inlining a secret into an environment variable at build time puts it in
    // the revision spec, where anyone with run.viewer can read it.
    const smtp = env.find((e) => attr(e.body, 'name') === '"SMTP_CREDENTIAL_SECRET"');
    expect(smtp?.body).toContain('google_secret_manager_secret.smtp.id');
  });

  it('AC-3: grants secretAccessor per secret, to exactly the identities that need it', () => {
    const grants = resources(BLOCKS, 'google_secret_manager_secret_iam_member');

    const pairs = grants.map((g) => {
      const secret = attr(g.body, 'secret_id') ?? '';
      const member = attr(g.body, 'member') ?? '';
      const which = secret.includes('.smtp.') ? 'smtp' : 'credential_key';
      const who = member.includes('.worker.') ? 'worker' : 'api';
      return `${who}:${which}`;
    });

    // The API service can decrypt a credential because retrieval terminates
    // there; it has no reason to hold the SMTP password and does not.
    expect(pairs.sort()).toEqual([
      'api:credential_key',
      'worker:credential_key',
      'worker:smtp',
    ]);

    for (const grant of grants) {
      expect(attr(grant.body, 'role')).toBe('"roles/secretmanager.secretAccessor"');
    }
    // Never at project scope.
    const projectSecretRoles = resources(BLOCKS, 'google_project_iam_member').filter((b) =>
      (attr(b.body, 'role') ?? '').includes('secretmanager'),
    );
    expect(projectSecretRoles).toEqual([]);
  });

  it('AC-7: claims no per-collection Firestore IAM anywhere', () => {
    // Firestore IAM is database-scoped. A binding or a comment asserting
    // collection-level permissions would be a control that does not exist, and
    // someone would rely on it.
    const firestoreRoles = resources(BLOCKS, 'google_project_iam_member').filter((b) =>
      (attr(b.body, 'role') ?? '').includes('datastore'),
    );
    expect(firestoreRoles.length).toBeGreaterThan(0);

    for (const binding of firestoreRoles) {
      expect(attr(binding.body, 'role')).toBe('"roles/datastore.user"');
      expect(binding.body).not.toMatch(/collection\s*=/);
    }
    expect(CONFIG).toMatch(/database-scoped/i);
  });

  it('AC-8: has exactly two secrets, each with a recorded removal path', () => {
    const secrets = resources(BLOCKS, 'google_secret_manager_secret');
    expect(secrets).toHaveLength(2);

    // A secret that can never go away is one nobody revisits.
    for (const secret of secrets) {
      expect(secret.body, `${secret.labels[1]} has no removable label`).toMatch(/removable\s*=/);
    }
  });
});

// ============================================================== REQ-018

describe('REQ-018: tamper-evident audit retention', () => {
  it('AC-3: grants the runtime identities no power to delete logs or alter retention', () => {
    // The whole shape of the control: the identities that PRODUCE audit records
    // cannot remove them. logging.logWriter is the narrowest role that permits
    // writing an entry and permits nothing else.
    const forbidden = [
      'roles/logging.admin',
      'roles/logging.configWriter',
      'roles/owner',
      'roles/editor',
    ];

    const runtimeBindings = resources(BLOCKS, 'google_project_iam_member').filter((b) => {
      const member = attr(b.body, 'member') ?? '';
      return (
        member.includes('google_service_account.api') ||
        member.includes('google_service_account.worker') ||
        member.includes('each.value')
      );
    });

    for (const binding of runtimeBindings) {
      const role = (attr(binding.body, 'role') ?? '').replace(/"/g, '');
      expect(forbidden, `${binding.labels[1]} grants ${role}`).not.toContain(role);
    }

    const loggingRoles = runtimeBindings
      .map((b) => (attr(b.body, 'role') ?? '').replace(/"/g, ''))
      .filter((r) => r.startsWith('roles/logging.'));
    expect(loggingRoles.sort()).toEqual(['roles/logging.logWriter', 'roles/logging.viewer']);
  });

  it('AC-4: locks the retention policy, with the period set from a variable', () => {
    const bucket = named('google_logging_project_bucket_config', 'audit');

    expect(attr(bucket.body, 'retention_days')).toBe('var.audit_retention_days');
    expect(attr(bucket.body, 'locked')).toBe('var.audit_bucket_locked');

    // The default is a compliance window, not the 30 days the platform would
    // have chosen — which is shorter than any retention obligation worth having
    // the control for.
    const retention = declared('variable', 'audit_retention_days');
    expect(Number(attr(retention.body, 'default'))).toBeGreaterThan(365);
    // And locking defaults ON. A control that has to be switched on is one that
    // will not be.
    expect(attr(declared('variable', 'audit_bucket_locked').body, 'default')).toBe('true');
  });

  it('AC-1: routes the mirror into that bucket rather than leaving it in _Default', () => {
    // Without the sink the entries land in _Default, whose 30-day retention is
    // editable by anyone with configWriter — the copy would exist and provide
    // no tamper-evidence at all.
    const sink = named('google_logging_project_sink', 'audit');
    expect(attr(sink.body, 'destination')).toContain(
      'google_logging_project_bucket_config.audit.id',
    );
    expect(attr(sink.body, 'filter')).toContain('local.audit_log_name');

    // And the worker is told which log to write to and which view to read back.
    const worker = named('google_cloud_run_v2_service', 'worker');
    const env = nested(worker.body, 'env');
    expect(env.find((e) => attr(e.body, 'name') === '"AUDIT_LOG_NAME"')?.body).toContain(
      'local.audit_log_name',
    );
    expect(env.find((e) => attr(e.body, 'name') === '"AUDIT_LOG_VIEW"')?.body).toContain(
      'local.audit_log_view',
    );
  });

  it('schedules the sweep, so the mirror is not a library nothing invokes', () => {
    const job = named('google_cloud_scheduler_job', 'audit_mirror');
    expect(attr(job.body, 'schedule')).toBe('var.audit_mirror_schedule');
    // The route is named in the task the job enqueues, not in the job's own
    // target — the job posts to Cloud Tasks, which posts to the worker.
    expect(CONFIG).toContain('/tasks/mirror-audit');
    expect(job.body).toContain('local.audit_sweep_task');
  });
});

// ============================================================== REQ-027

describe('REQ-027: Workspace tenant configuration', () => {
  it('AC-1: enables the Admin SDK API in Terraform', () => {
    // The tenant-side grant is made in the Admin console and cannot be
    // Terraform; enabling the API it calls can be, and is.
    expect(CONFIG).toContain('"admin.googleapis.com"');

    const services = resources(BLOCKS, 'google_project_service');
    expect(services).toHaveLength(1);
    expect(attr(services[0]!.body, 'for_each')).toContain('local.required_services');
  });

  it('AC-5: configures no Domain-Wide Delegation anywhere in the deployment', () => {
    // The customer's constraint. It has no Terraform resource — DWD is a tenant
    // setting — so what is checkable here is that nothing pretends to configure
    // one and no impersonation subject appears.
    expect(CONFIG).not.toMatch(/domain[_\s-]?wide[_\s-]?delegation\s*=/i);
    expect(CONFIG).not.toMatch(/\bsubject\s*=\s*"/);
    expect(CONFIG).not.toMatch(/impersonat/i);
  });

  it('names the worker identity in an output, since that is what the role is assigned to', () => {
    const output = BLOCKS.find(
      (b) => b.type === 'output' && b.labels[0] === 'worker_service_account',
    );
    expect(output).toBeDefined();
    expect(output!.body).toContain('google_service_account.worker.email');
  });
});
