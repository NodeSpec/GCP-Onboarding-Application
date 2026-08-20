# The Pack: GCP Onboarding Console

A console for creating, updating and removing Google Workspace accounts, with an approval step and a full record of who did what.

## What this is, in plain terms

When someone joins a company, somebody has to create their email account, put them in the right team groups, fill in their job title and department, and tell them how to log in for the first time. When they change roles, those groups and details need updating. When they leave, the account has to be shut down without losing their files.

Google Workspace can already do all of that. An administrator can log into the Google admin console and click through it by hand. So why build this?

Three reasons.

**Not everyone should be an administrator.** In Google Workspace, creating or deleting an account requires administrator rights, and that same access lets a person reset anyone's password and read anyone's account settings. Giving that to every helpdesk technician is more access than the job needs. This application lets a person perform exactly four actions and nothing else, without ever opening the admin console.

**Some actions should need a second person to agree.** Google Workspace has no approval step. An administrator clicks delete and the account is gone. Here, any step can be configured to pause until a second, different person approves it. Deleting an account always requires that second approval and cannot be configured otherwise.

**Half finished work should not be invisible.** Setting up a new starter is not one action, it is a sequence: create the account, apply attributes, add each group, send the welcome letter. If one of those fails partway through, the admin console leaves no record of what is left to do. This application tracks every step, so a stalled setup is visible and can be picked up exactly where it stopped.

The result is a small internal tool that sits in front of Google Workspace and adds the process, the permissions and the paper trail around actions Workspace already supports.

## What it does

Four phases, matching the four things that happen to an account over its life.

1. **Create.** Makes the Workspace user, applies attributes (name, job title, department, manager, organisational unit), and adds the person to each requested group. Each group is added as its own step, so one failure does not undo the rest.

2. **Notify.** Sends a welcome letter to a personal or manager relayed address, because the new mailbox cannot be read until the person signs in for the first time. The letter contains instructions but no password. The temporary password is retrieved once by the person who submitted the request and handed over separately.

3. **Update.** Changes attributes, organisational unit and group memberships on an existing account. The change is calculated against the account's current live state at the moment it runs, so an approver sees exactly what will change rather than a raw form submission.

4. **Delete.** Runs in stages: suspend the account, revoke active sessions and tokens, remove group memberships, optionally transfer file ownership to a named successor, then delete. An optional hold period sits between suspension and deletion, during which the request can be cancelled and the account restored.

## How it is built

Everything runs serverless on Google Cloud. There are no virtual machines and no Kubernetes clusters, and both services scale to zero when idle.

Two Cloud Run services, deliberately separated:

* **Lifecycle API Service** serves the operator console and the API. It handles sign in, roles, approvals and request creation. It holds no Workspace administrator rights at all.
* **Lifecycle Step Executor** runs one step at a time and is the only service that can change anything in Google Workspace. It is not reachable from the internet.

The separation is the point. If the operator facing surface is ever compromised, it cannot modify the directory, because it does not hold the permission to do so.

Supporting pieces: Firestore stores request state and the audit trail, Cloud Tasks delivers step execution reliably with retries, Secret Manager holds the two credentials the system needs, and Cloud Logging keeps a tamper evident copy of the audit record. A small VPC carries the API service's outbound traffic so its calls to the worker arrive as internal traffic and pass the worker's ingress restriction, with Cloud NAT providing the one internet path sign-in itself depends on.

For the full component list, connection topology and per component task documents, see [ARCHITECTURE.md](./ARCHITECTURE.md), which is generated from the NodeSpec model. For the reasoning behind the arrangement, including the trust boundaries and what each store holds, see [docs/architecture.md](./docs/architecture.md).

### Two design decisions worth knowing about

**No Domain-Wide Delegation.** The usual way an application gets Workspace administrator access is Domain-Wide Delegation, which lets the application act as any user in the company. That is a large amount of trust. Instead, a custom Workspace administrator role is assigned directly to the worker's service account, carrying only the privileges the four phases need. The service account acts as itself and impersonates nobody. Setup instructions are in `docs/workspace-admin-setup.md`.

**Every route sits behind Identity-Aware Proxy.** Google's Identity-Aware Proxy authenticates every person before their request reaches the application. The application does not trust that on its own: it independently verifies the signed token IAP attaches to each request, and rejects anything that fails, before any handler runs. There are no unauthenticated routes anywhere in the system.

## Repository layout

```
packages/schemas/       Request payload schemas. Imported by the console, so
                        client and server validate with the same code.
packages/shared/        Model, transition guard, data access, audit mirror,
                        credential crypto
packages/test-support/  Emulator fixtures shared by every suite
services/api/           Lifecycle API Service (Node.js, TypeScript)
services/worker/        Lifecycle Step Executor (Node.js, TypeScript)
services/console/       Operator console (React). Built into the API image.
infra/                  Terraform for the whole deployment, plus the tests
                        that assert its invariants
docs/                   Setup, deployment, policy and runbook guides
.nodespec/              Specification, architecture model and per component
                        task documents
```

`.nodespec/` is generated. Edit the specification in NodeSpec, not the files.

## Prerequisites

* A Google Cloud project with billing enabled, and its project **number** as
  well as its id
* A Google Workspace tenant you administer as a Super Admin
* A domain you control, and the ability to create a DNS A record for it
* A Google group for operators. Access is granted by group membership, so this
  is a group rather than a list of people
* Node.js 22 or later
* Terraform 1.9 or later
* Docker, and an Artifact Registry repository
* `gcloud` CLI, authenticated

## Configuration

Every service reads configuration from environment variables, validated at startup. A service exits immediately if a required variable is missing or malformed, rather than failing later on the first request.

Terraform sets all of these on both Cloud Run services. The table is here so you can read a deployed revision and know what you are looking at, not because you set them by hand.

| Variable | Used by | Purpose |
|---|---|---|
| `GCP_PROJECT_ID` | api, worker | Project holding Firestore, Tasks and Secret Manager |
| `IAP_AUDIENCE` | api | Expected audience of the IAP token. Comes from Terraform output. |
| `FIRESTORE_DATABASE` | api, worker | Firestore database id, usually `(default)` |
| `TASKS_QUEUE` | api, worker | Cloud Tasks queue name |
| `TASKS_LOCATION` | api, worker | Region of the queue |
| `WORKER_BASE_URL` | api, worker | Worker service URL, the OIDC audience for dispatched tasks |
| `QUEUE_INVOKER_SA` | api, worker | Service account Cloud Tasks uses to call the worker |
| `API_SERVICE_SA` | worker | The identity admitted on the worker's lookup routes |
| `BOOTSTRAP_ADMINS` | api | Comma separated. Holds `admin` before any role binding exists. |
| `PROTECTED_ACCOUNTS` | api | Comma separated extra addresses no request may target |
| `CONSOLE_BASE_URL` | worker | Where approval notices link to |
| `WORKSPACE_CUSTOMER_ID` | worker | The tenant's real customer id (`C01ab2cd3` shape). The `my_customer` alias cannot work for a service account and is refused at plan time |
| `WORKSPACE_MODE` | worker | Accepts `live` and `dry-run`, but only `live` is implemented. See the note under Running locally. |
| `SMTP_HOST`, `SMTP_PORT` | worker | Relay endpoint, `smtp-relay.gmail.com` and `587` |
| `SMTP_SENDER` | api, worker | The no reply address letters are sent from. Protected automatically. |
| `SMTP_RETURN_PATH` | worker | Envelope sender, so bounces reach a monitored group |
| `RETURN_PATH_GROUP` | api | The same group, protected automatically |
| `SMTP_CREDENTIAL_SECRET` | worker | Secret Manager resource name of the relay app password |
| `CREDENTIAL_KEY_SECRET` | api, worker | Secret Manager resource name of the encryption key |
| `AUDIT_LOG_NAME` | worker | Log the audit mirror writes to. Absent, the sweep reports `not_configured`. |
| `AUDIT_LOG_VIEW` | worker | Bucket view reconciliation reads the mirrored copy back through |

Two of these are worth understanding rather than just setting.

`IAP_AUDIENCE` must match what Terraform produced, exactly. The application verifies every assertion against it, so a value that has drifted from the perimeter rejects every request and produces a console nobody can sign in to, with nothing in any log explaining why. It is wired from a Terraform output for that reason. If you ever find yourself pasting it, stop.

`BOOTSTRAP_ADMINS` is the only way into an empty role binding store. Granting the first admin would otherwise require an admin. Put yourself in it for the first deployment, grant real bindings through the console, then decide whether to remove yourself.

## Running locally

Local development runs the two services directly, with Google credentials borrowed from your own account.

```bash
gcloud auth application-default login

cd services/api && npm install && npm run dev      # http://localhost:8080
cd services/worker && npm install && npm run dev    # http://localhost:8081
```

Identity-Aware Proxy does not exist locally, so there is no real token to verify. Set `AUTH_MODE=dev-insecure` and `DEV_OPERATOR_EMAIL=you@company.com` to make the API service accept a simulated identity. Two things protect you from shipping that by accident: the service refuses to start with `AUTH_MODE=dev-insecure` unless `NODE_ENV` is `development`, and a test asserts the same. It is never a deployment option.

To run against Firestore without touching real data, start the emulator first:

```bash
gcloud emulators firestore start --host-port=localhost:8090
export FIRESTORE_EMULATOR_HOST=localhost:8090
```

Workspace calls have no emulator, so point local development at a test tenant.

`WORKSPACE_MODE=dry-run` is **not implemented**, and this is worth stating plainly because the name promises otherwise. The value is validated at startup and printed in one log line, and nothing reads it after that. Setting it changes nothing: the worker still makes live Workspace calls. Do not rely on it as a safety net. Either point at a tenant you are willing to have modified, or do not run the worker.

### Verifying before you deploy

Worth doing first, because a failure here is cheaper to diagnose than the same failure against a live tenant.

```bash
npm install
npm run build          # every package, plus the console into services/api/public
npm run typecheck
npm run test           # unit, component and infrastructure suites
npm run test:emulator  # starts the Firestore emulator around its own suite
```

`npm run verify` runs all of the above in order.

The infrastructure suite reads the committed Terraform and asserts the invariants the requirements name: exactly one load balancer backend and it has IAP enabled, exactly two principals holding `run.invoker` on the worker, no VM or Kubernetes resource anywhere, images pinned by digest. It needs no GCP project and no provider download, so it runs in CI.

What it cannot do is `terraform validate` or `terraform plan`, both of which need the provider registry and a project. Run those yourself before the first apply:

```bash
cd infra && terraform init && terraform validate
```

## Deploying and live testing

Order matters, because the application needs values that only exist after the infrastructure does, and the Workspace side needs the service account identity that only exists after the apply.

**[docs/deployment.md](./docs/deployment.md) is the runbook.** It is copy and paste from an empty project to a working console, with one variables block at the top and a troubleshooting section covering everything that commonly goes wrong. [docs/workspace-admin-setup.md](./docs/workspace-admin-setup.md) covers the tenant side in the same way. This section is the map, not the commands.

**You deploy by hand exactly once.** After the first deployment works, [docs/cicd.md](./docs/cicd.md) sets up two GitHub Actions workflows: one that builds, typechecks and tests every push, and one that builds both images, pushes them by digest and applies the Terraform on every merge to the default branch. Authentication is Workload Identity Federation, so no service account key ever exists. From then on, shipping a change is a merge, and nothing in the deployment is done by hand again except the parts that have no API: the Workspace tenant settings and the two secret values.

### The path

1. **Install the tools and enable the APIs.** Cloud Shell no longer ships Terraform, so it is installed into your home directory. Every API is enabled with `gcloud` up front rather than left to Terraform, because `gcloud` blocks until each one is live and Terraform does not, which otherwise fails the first apply.

2. **Build and push the images.** Both are referenced by immutable digest; Terraform refuses a mutable tag at plan time. The console has no deployment of its own, it is built into the API image and served behind IAP, which is what keeps the browser's IAP cookie the only credential in play.

3. **Write `infra/terraform.tfvars`.** Your deployment values, ignored by git and never tracked. Five of them are specific to your organisation. Note `audit_bucket_locked`: locking the audit retention policy is **IRREVERSIBLE**, so set it false for a scratch project you intend to delete.

4. **Run `terraform apply`.** About 70 resources. On Cloud Shell use `-parallelism=3`, because the default concurrency provokes transient network failures against Google's APIs.

5. **Point DNS at the load balancer.** The managed certificate cannot issue until the record resolves, and the console is unreachable until it does. Fifteen minutes to an hour is normal.

6. **Do the Workspace side.** A custom admin role carrying only what the four phases need, assigned to the worker service account and to nothing else, with Domain-Wide Delegation confirmed absent. Terraform cannot do any of this, because Workspace admin roles are not GCP resources.

7. **Populate the secrets.** Both are created empty on purpose: a value passed through a Terraform variable is written to state in plaintext. Neither needs a redeploy, now or on any future rotation.

8. **Grant operator access.** Add people to the operator group. Membership gets someone past IAP; a role binding decides what they may do once there. Someone in the group with no binding is authenticated and authorized for nothing, which is the right state for a person who should be able to look but not act.

9. **Set up the pipeline.** One-time: a state bucket, a deployer service account, Workload Identity Federation, and a set of repository variables, all in `docs/cicd.md`. Every deployment after this one is a merge.

### Three things that catch people out

**Workspace licences.** The create phase provisions a real user, which consumes a seat. A dedicated no-reply sending account consumes another. On a small tenant those compete, so either buy a spare seat or send from your own admin address and keep the spare free for the lifecycle to use.

**Custom admin roles are gated by Workspace edition.** Check that **Account > Admin roles > Create new role** exists before you start. If it does not, prebuilt roles work but grant more than least privilege, and that difference is worth recording rather than leaving implicit.

**The operator group must exist before you apply.** IAP validates it and refuses a group it cannot find.

### Live test walkthrough

Run these in order. Each one checks a specific claim rather than a general "does it work". `docs/deployment.md` has the exact commands.

**The platform refuses a direct request.** Expected to fail: a 404, a 403 or a connection failure all pass, and 404 is the usual answer because ingress is restricted to the load balancer. **A 200 is a finding**, and means the perimeter is bypassable.

**The perimeter asks for authentication.** The console URL should redirect into the Google sign-in flow.

**An account outside the operator group is refused.** Sign in from a private window as someone not in the group. They should be stopped at the perimeter and never reach the application. This is the one worth doing deliberately; it is easy to assume and cheap to check.

**A member of the group reaches the console.** Sign in as your bootstrap admin. The console should name you and list your roles.

**The directory pickers work.** Open the new-request form. If the target-user search returns results and the group and org-unit pickers populate, the Workspace grant is live and the whole read path works. If they are empty, the custom admin role is not assigned correctly.

**Onboarding, end to end.** Submit a create request against a test address. Watch the step timeline: validate, create, apply attributes, one step per group, verify. Then check the account exists in the Admin console with `changePasswordAtNextLogin` set.

**Retrieve the password.** Once, from the request detail. Try again and confirm you get 410. Try from a second operator's account and confirm 403.

**The welcome letter.** Submit a notify request with a personal address as the notification address. Confirm it arrives, in the inbox, and confirm it contains no password and no claim link.

**Two-party approval.** Submit a delete request against the test account. It should suspend, revoke and remove memberships, then halt before `delete-user` and wait for an admin. Confirm an approver notice arrived, and that the requester did not receive one. Follow the link in it and confirm it lands on the request detail after signing in.

**Approve with no justification.** Confirm the server refuses with a 400 and that the console shows the server's message rather than its own.

**Cancellation and compensation.** Submit another delete, let it suspend, then cancel it. The request should move to `compensating` rather than `cancelled`, and reach `cancelled` only once the account is unsuspended. Confirm the account is usable again.

**Protected accounts.** Submit a delete request against your sending account. Expect a 409 with `protected_account`, and confirm no request document was written. Try it as an admin too; protection is not a permission level.

**The audit mirror.** Wait five minutes for the scheduled sweep, then confirm entries are arriving in the `lifecycle-audit` log.

**The retention lock.** Confirm it refuses to be weakened by attempting to shorten the bucket's retention. A success means the bucket was not locked.

When something does not behave as described here, [docs/runbook.md](./docs/runbook.md) is organised by symptom.

## How a request flows

Taking a new starter as the example:

1. An operator signs in. IAP authenticates them and attaches a signed token. The API service verifies that token independently and rejects the request if anything about it is wrong.
2. The operator fills in the creation form. Users, groups and organisational units are chosen from pickers backed by live Workspace data, so a typo cannot reach the queue.
3. On submission the API service validates the request, writes it to Firestore along with one record per step, and freezes the approval policy onto the request so a later policy change cannot alter a request already in flight.
4. If the first step needs approval it pauses, and an email goes to the people eligible to approve it. That email is queued in the same database transaction as the pause, so a paused request always has its notification scheduled.
5. An approver opens the request in the console, sees exactly what will change, and approves or rejects it with a written reason. Nobody can approve their own request.
6. Cloud Tasks delivers each step to the worker. The worker checks the current state in Workspace before changing anything, so a step that has already taken effect is skipped rather than repeated.
7. Every transition writes an audit record in the same transaction as the change itself, so a change can never exist without its audit entry.
8. When the account exists, the welcome letter goes to the address given on the request. The temporary password is retrieved once by the operator who submitted it and passed on separately.

If anything fails partway, the request stops with the error recorded against the specific step, and an administrator can resume or cancel it. Nothing is left in an unknown state.

## Security model

* Every route requires an identity proven by Identity-Aware Proxy and verified again by the application. There are no unauthenticated routes.
* The worker is not on the load balancer. It accepts calls only from Cloud Tasks and from the API service's lookup requests, each restricted to its own routes.
* Only the worker's service account holds Workspace administrator rights.
* No Domain-Wide Delegation is configured anywhere.
* No service account key files exist. Google credentials come from the runtime metadata server.
* Temporary passwords are stored encrypted, never as plain text, and are readable exactly once.
* Passwords, tokens and credentials are stripped from every log.
* Audit records are mirrored to a Cloud Logging bucket with a locked retention policy that no runtime identity can shorten.

## Extending the system

Underneath the four phases this is a durable approval and audit engine, and Google Workspace is its first adapter. That is what makes it extensible, and it is also what makes some extensions dangerous. This section covers what fits, what needs care, and what would quietly dismantle the security model above.

### The four extension points

| Point | Where | What it gives you |
|---|---|---|
| Step handler registry | `services/worker/src/steps/handler.ts` | A new kind of step, executed with the existing retry, idempotency and audit guarantees |
| Step plan | `packages/shared/src/stepPlans.ts` | A new phase, or new steps within one |
| Scheduled dispatch | `packages/shared/src/dispatcher.ts` | `enqueueStep` already accepts `scheduleAt`, so future dated work needs no new machinery |
| Notification sender | `services/worker/src/notify/` | A new delivery channel, without a second delivery path |

Anything registered through these inherits the properties the rest of the system already proves: at least once delivery, a pre mutation state read so a replay changes nothing, an audit event written in the same transaction as the change, and approval gating from the snapshotted policy.

### Extensions that fit cleanly

**Future dated requests.** Somebody starts on the 14th and leaves on the 30th, and both are known weeks ahead. `scheduleAt` already reaches Cloud Tasks, so this is holding the first dispatch rather than new infrastructure.

**Role templates.** A named bundle of groups, org unit and title, expanded into a payload before the plan is built. This is where onboarding consistency actually comes from, and it turns the scope reading of "roles" in `docs/architecture.md` into data rather than prose.

**Bulk onboarding.** Fan a cohort out into one request per person. The per target concurrency guard already prevents two requests racing the same account, and separate step plans mean one failure does not stall the rest.

**More offboarding steps.** Mailbox delegation to the manager, calendar handover, forwarding, group ownership transfer, licence reclamation. Each is a step handler and each inherits the two party approval already required before deletion.

**Drift detection.** The verify step already compares intended state against live Workspace. Generalised and run on a schedule, using the Cloud Scheduler job that drives the audit mirror, it catches changes made by hand in the admin console.

**A preview mode.** Phase 3 computes a full diff before it mutates anything. Exposing that for every phase gives an operator a real what if, and would make `WORKSPACE_MODE=dry-run` mean something.

**Additional notification channels.** Approvals reach people faster in chat than in mail. The sender interface exists precisely so a channel is a new implementation rather than a second delivery path.

### Extensions that need care

**Inbound HRIS or IdP integration.** The highest value addition, and the one most likely to be built wrongly. A webhook endpoint on the API service would be an unauthenticated route, which the system does not have and a test asserts it does not gain. Do it as an authenticated ingestion path instead: a separate Cloud Run service with its own caller identity, or a Pub/Sub subscription, writing requests through the same admission logic. The approval layer then becomes the human checkpoint on an automated pipeline, which is the point.

**Targets outside Google.** The handler registry does not care that a step talks to Workspace. Each new system is a new credential in Secret Manager and a new blast radius, so add them one at a time with their own least privilege grant, not one shared administrative token.

**Org unit scoped roles.** Roles are global today. Scoping them so an operator may onboard into one part of the domain and not another is a change to the role resolver, and it has to fail closed: an unrecognised scope grants nothing.

**Emergency offboarding.** Deletion requires two party approval, which is correct in normal operation and wrong during an incident. An immediate suspend path is defensible if it is time boxed, audited identically, and still requires justification after the fact. A permanent bypass is not.

### What would break the security model

Each of these is enforced by a test, and that is deliberate. If a change requires deleting one of these assertions, the change is the problem.

* **Do not give the API service Workspace credentials.** The separation between the operator facing surface and the only identity that can mutate the directory is the primary control. New Workspace capability belongs in the worker, reached as a step or as a read only lookup.
* **Do not configure Domain-Wide Delegation, for any feature.** It lets the application act as any user in the domain, including super admins. A feature that appears to need it needs a design conversation instead. A repository wide scan fails the build if it appears in code or in infrastructure.
* **Do not add role management privilege to the custom admin role.** It would let the service account grant itself Super Admin. Every other privilege in that list is bounded by the list; that one is not.
* **Do not add a load balancer backend without IAP.** There is exactly one backend service and it has IAP enabled, asserted so that a second one fails rather than quietly opening a second way in.
* **Do not let the console enforce anything.** Hiding a control is presentation. Every new action needs its own server side role check, because the API is reachable without the console.
* **Do not mutate Workspace outside the step executor.** A direct call from a route skips idempotency, error classification, approval gating and the audit write that shares its transaction.
* **Do not broaden the runtime identities.** They hold `logging.logWriter` and not `logging.admin` so that the identities producing audit records cannot remove them.
* **Do not trust client supplied identity.** It comes from the verified IAP assertion and nowhere else.
* **Do not add a secret bearing field without adding it to the redaction filter.** The filter matches known key names, so a new name is a new leak until it is listed.

## Specification

The requirements, architecture and per component task documents live in `.nodespec/` and are generated from the NodeSpec model. Each component has a task document listing the acceptance criteria it owns. Change the specification in NodeSpec and regenerate, rather than editing those files by hand.
