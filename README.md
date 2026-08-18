# GCP Onboarding Application

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

Supporting pieces: Firestore stores request state and the audit trail, Cloud Tasks delivers step execution reliably with retries, Secret Manager holds the two credentials the system needs, and Cloud Logging keeps a tamper evident copy of the audit record.

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
| `WORKSPACE_CUSTOMER_ID` | worker | Workspace customer id, or `my_customer` |
| `WORKSPACE_MODE` | worker | `live`, or `dry-run` to log Workspace calls without making them |
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

Workspace calls have no emulator. Point local development at a test tenant, or run the worker with `WORKSPACE_MODE=dry-run`, which logs the calls it would make and returns believable responses without changing anything.

### Verifying before you deploy

Worth doing first, because a failure here is cheaper to diagnose than the same failure against a live tenant.

```bash
npm ci
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

`docs/deployment.md` and `docs/workspace-admin-setup.md` are the full references. This is the path through them.

### 0. Before you touch anything

Terraform enables every API the system needs, but it cannot enable the API it needs to do that:

```bash
export PROJECT_ID=your-project-id
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export REGION=us-central1

gcloud services enable cloudresourcemanager.googleapis.com --project "$PROJECT_ID"
```

Then confirm app passwords are available in your Workspace tenant, under **Security > Authentication > 2-step verification**. If they are disabled, the SMTP relay design does not work and the notification path has to change before you build anything on it. This is the one check worth doing first, because discovering it late invalidates several later steps.

### 1. Build and push the images

Both images are pinned by digest. Terraform rejects a tag at plan time, because a tag is a mutable pointer and the same state would then describe different running code depending on when it was applied.

```bash
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/lifecycle"
gcloud artifacts repositories create lifecycle \
  --repository-format=docker --location="$REGION" --project "$PROJECT_ID"
gcloud auth configure-docker "${REGION}-docker.pkg.dev"

npm ci
npm run build          # also builds the console into services/api/public

docker build -f services/api/Dockerfile    -t "$REGISTRY/api:build"    .
docker build -f services/worker/Dockerfile -t "$REGISTRY/worker:build" .
docker push "$REGISTRY/api:build"
docker push "$REGISTRY/worker:build"

export API_DIGEST=$(gcloud artifacts docker images describe "$REGISTRY/api:build" --format='value(image_summary.digest)')
export WORKER_DIGEST=$(gcloud artifacts docker images describe "$REGISTRY/worker:build" --format='value(image_summary.digest)')
echo "$REGISTRY/api@$API_DIGEST"
echo "$REGISTRY/worker@$WORKER_DIGEST"
```

The console has no deployment of its own. It is built into the API image and served by the API service behind IAP, which is what keeps the browser's IAP cookie the only credential involved.

### 2. Write `infra/terraform.tfvars`

```hcl
project_id     = "your-project-id"
project_number = "123456789012"
region         = "us-central1"

domain            = "lifecycle.example.com"
operator_group    = "lifecycle-operators@example.com"
iap_support_email = "you@example.com"

api_image    = "us-central1-docker.pkg.dev/your-project-id/lifecycle/api@sha256:..."
worker_image = "us-central1-docker.pkg.dev/your-project-id/lifecycle/worker@sha256:..."

smtp_sender      = "no-reply@example.com"
smtp_return_path = "lifecycle-bounces@example.com"

bootstrap_admins = ["you@example.com"]

# Locking is IRREVERSIBLE. Leave it true for a real deployment. Set it false
# for a scratch project you intend to delete, or you will pin seven years of
# logs to a project nobody can remove.
audit_bucket_locked = true
```

### 3. Apply

```bash
cd infra
terraform init
terraform plan -out=tfplan
terraform apply tfplan
terraform output
```

The managed TLS certificate will sit in `PROVISIONING` until DNS resolves. That is expected and the next step fixes it.

### 4. Point DNS at the load balancer

```bash
terraform output -raw console_ip
```

Create an A record for your domain against that address, then wait for the certificate:

```bash
watch -n 60 "gcloud compute ssl-certificates describe lifecycle-console-cert \
  --global --project $PROJECT_ID --format='value(managed.status)'"
```

Fifteen minutes to an hour is normal. Several hours happens.

### 5. Do the Workspace side

Terraform cannot do any of this, because Workspace admin roles are not GCP resources. Follow `docs/workspace-admin-setup.md`; the shape of it is:

1. Create the no reply account. No admin role, enrolled in 2-step verification, belonging to no person. Generate its app password.
2. Configure the SMTP relay to accept it as a sender **and permit any recipient**, since welcome letters go to personal addresses outside the domain. A relay restricted to internal recipients accepts the connection and refuses every letter that matters.
3. Configure SPF, DKIM and DMARC, then send one real letter to a real external address and confirm it lands in the inbox rather than spam.
4. Create the custom admin role carrying only Users read/create/update/delete, Groups read/update, Org Units read, and Data Transfer if you use Drive transfer. **No role-management privilege of any kind.**
5. Assign it to the worker service account by email, under **Account > Admin roles > Assign service accounts**:

   ```bash
   terraform output -raw worker_service_account
   ```

6. Confirm **Security > API controls > Manage Domain Wide Delegation** contains no entry for that service account. There should be nothing to remove; check anyway.

### 6. Populate the secrets

Both were created empty, deliberately: a value passed through a Terraform variable is written to state in plaintext.

```bash
openssl rand -base64 32 | tr -d '\n' | \
  gcloud secrets versions add credential-encryption-key --data-file=- --project "$PROJECT_ID"

printf '%s' "$APP_PASSWORD" | \
  gcloud secrets versions add notification-smtp-credentials --data-file=- --project "$PROJECT_ID"
```

Neither needs a redeploy, now or on any future rotation.

### 7. Grant operator access

```bash
gcloud identity groups memberships add \
  --group-email="lifecycle-operators@example.com" \
  --member-email="colleague@example.com"
```

Reaching the application and being allowed to do anything in it are separate decisions. Group membership gets someone past IAP; a role binding decides what they can do once there. Someone in the group with no binding is authenticated and authorized for nothing, which is the right state for a person who should be able to look but not act.

Role bindings can be individual or by group. A group binding grants its roles to every member, resolved through the worker's directory lookup.

### Live test walkthrough

Run these in order. Each one depends on the last, and each is checking a specific claim rather than a general "does it work".

**The platform refuses a direct request.** This one should FAIL, and a success means ingress is misconfigured and the perimeter is bypassable:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$(terraform output -raw api_service_url)"
# Expect 403 or a connection failure. A 200 is a finding.
```

**The perimeter asks for authentication:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://lifecycle.example.com"
# Expect a redirect into the Google sign-in flow.
```

**An account outside the operator group is refused.** Sign in from a private window as someone not in the group. They should be stopped at the perimeter and never reach the application. This is the one worth doing deliberately; it is easy to assume and cheap to check.

**A member of the group reaches the console.** Sign in as your bootstrap admin. The console should name you and list your roles.

**The directory pickers work.** Open the new-request form. If the target-user search returns results and the group and org-unit pickers populate, the Workspace grant is live and the whole read path is working. If they are empty, the custom admin role is not assigned correctly; go back to step 5.

**Onboarding, end to end.** Submit a create request against a test address. Watch the step timeline: validate, create, apply attributes, one step per group, verify. Then check the account exists in the Admin console with `changePasswordAtNextLogin` set.

**Retrieve the password.** Once, from the request detail. Try again and confirm you get 410. Try from a second operator's account and confirm 403.

**The welcome letter.** Submit a notify request with a personal address as the notification address. Confirm it arrives, in the inbox, and confirm it contains no password and no claim link.

**Two-party approval.** Submit a delete request against the test account. It should suspend, revoke and remove memberships, then halt before `delete-user` and wait for an admin. Confirm an approver notice arrived, and that the requester did not receive one. Follow the link in it and confirm it lands on the request detail after signing in.

**Approve with no justification.** Confirm the server refuses with a 400 and that the console shows the server's message rather than its own.

**Cancellation and compensation.** Submit another delete, let it suspend, then cancel it. The request should move to `compensating` rather than `cancelled`, and reach `cancelled` only once the account is unsuspended. Confirm the account is usable again.

**Protected accounts.** Submit a delete request against your no reply sending account. Expect a 409 with `protected_account`, and confirm no request document was written. Try it as an admin too; protection is not a permission level.

**The audit mirror.** Wait five minutes for the scheduled sweep, then confirm entries are arriving:

```bash
gcloud logging read 'logName="projects/'"$PROJECT_ID"'/logs/lifecycle-audit"' \
  --limit 5 --project "$PROJECT_ID"
```

**The retention lock.** Confirm it refuses to be weakened:

```bash
gcloud logging buckets update lifecycle-audit --location=global \
  --retention-days=1 --project "$PROJECT_ID"
# Expect a refusal. A success means the bucket was not locked.
```

When something does not behave as described here, `docs/runbook.md` is organised by symptom.

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

## Specification

The requirements, architecture and per component task documents live in `.nodespec/` and are generated from the NodeSpec model. Each component has a task document listing the acceptance criteria it owns. Change the specification in NodeSpec and regenerate, rather than editing those files by hand.
