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

For the full component list, connection topology and per component task documents, see [ARCHITECTURE.md](./ARCHITECTURE.md), which is generated from the NodeSpec model.

### Two design decisions worth knowing about

**No Domain-Wide Delegation.** The usual way an application gets Workspace administrator access is Domain-Wide Delegation, which lets the application act as any user in the company. That is a large amount of trust. Instead, a custom Workspace administrator role is assigned directly to the worker's service account, carrying only the privileges the four phases need. The service account acts as itself and impersonates nobody. Setup instructions are in `docs/workspace-admin-setup.md`.

**Every route sits behind Identity-Aware Proxy.** Google's Identity-Aware Proxy authenticates every person before their request reaches the application. The application does not trust that on its own: it independently verifies the signed token IAP attaches to each request, and rejects anything that fails, before any handler runs. There are no unauthenticated routes anywhere in the system.

## Repository layout

```
services/api/      Lifecycle API Service (Node.js, TypeScript)
services/worker/   Lifecycle Step Executor (Node.js, TypeScript)
web/               Operator console (React)
infra/             Terraform for the whole deployment
docs/              Setup, deployment, policy and runbook guides
.nodespec/         Specification, architecture model and per component task documents
```

`.nodespec/` is generated. Edit the specification in NodeSpec, not the files.

## Prerequisites

* A Google Cloud project with billing enabled
* A Google Workspace tenant you administer
* Node.js 22 or later
* Terraform 1.9 or later
* `gcloud` CLI, authenticated

## Configuration

Every service reads configuration from environment variables, validated at startup. A service exits immediately if a required variable is missing or malformed, rather than failing later on the first request.

| Variable | Used by | Purpose |
|---|---|---|
| `GCP_PROJECT_ID` | api, worker | Project holding Firestore, Tasks and Secret Manager |
| `IAP_AUDIENCE` | api | Expected audience of the IAP token. Comes from Terraform output. |
| `FIRESTORE_DATABASE` | api, worker | Firestore database id, usually `(default)` |
| `TASKS_QUEUE` | api, worker | Cloud Tasks queue name |
| `TASKS_LOCATION` | api, worker | Region of the queue |
| `WORKER_BASE_URL` | api, worker | Worker service URL, the OIDC audience for dispatched tasks |
| `QUEUE_INVOKER_SA` | api, worker | Service account Cloud Tasks uses to call the worker |
| `WORKSPACE_CUSTOMER_ID` | worker | Workspace customer id, or `my_customer` |
| `SMTP_HOST`, `SMTP_PORT` | worker | Relay endpoint, `smtp-relay.gmail.com` and `587` |
| `SMTP_SENDER` | worker | The no reply address letters are sent from |
| `SMTP_CREDENTIAL_SECRET` | worker | Secret Manager resource name of the relay app password |
| `CREDENTIAL_KEY_SECRET` | api, worker | Secret Manager resource name of the encryption key |

The `IAP_AUDIENCE` value must match what Terraform produced. A mismatch is the most common cause of a working deployment rejecting every request, so it is wired from a Terraform output rather than copied by hand.

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

## Deploying

Order matters, because the application needs values that only exist after the infrastructure does.

```bash
cd infra
terraform init
terraform apply
```

That provisions the Firestore database and indexes, the Cloud Tasks queue, both Cloud Run services and their separate service accounts, the load balancer, Identity-Aware Proxy, Secret Manager entries and every IAM binding.

Then complete the three steps Terraform cannot perform, because they happen inside Google Workspace rather than Google Cloud:

1. Create the custom Workspace administrator role and assign it to the worker's service account, following `docs/workspace-admin-setup.md`. Do not configure Domain-Wide Delegation.
2. Create the no reply Workspace account, generate an app password, and store it in Secret Manager under the name Terraform printed.
3. Turn on the Workspace SMTP relay and allow the no reply account to send to any recipient, since welcome letters go to personal addresses outside the company.

Finally, grant your operators access. Add them to the Google group Terraform bound to Identity-Aware Proxy, then set their application roles (requester, approver or admin) in the console. Being able to reach the application and being allowed to do something in it are separate decisions.

Full walkthrough in `docs/deployment.md`.

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
