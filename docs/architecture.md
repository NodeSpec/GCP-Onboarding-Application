# Architecture

Applies to: lifecycle console 0.1.0

What the pieces are, where the trust boundaries fall, and what each store holds.

`ARCHITECTURE.md` at the repository root is the generated component inventory.
This document is the reasoning: why the pieces are arranged this way and what
would break if they were not.

## Components

### Operator Console UI

A single-page React application. Served as static assets **by the API service**,
not from a bucket.

That is a deliberate choice and it is load bearing. Sharing an origin with the
API means the browser's IAP cookie is the only credential in play. A separate
static origin would force a token into the browser to reach the API, and the
console would then hold an authorization artifact a user can edit.

The console holds no auth state. It asks `GET /api/me` on every load and renders
according to the roles the server reports. Hiding a control is presentation
only; every action is authorized again server side.

### Lifecycle API Service (Cloud Run)

The operator-facing surface. Admits requests, snapshots the approval policy onto
them, records approval decisions, serves the console, and hands the one-time
password to the operator who created the request.

It does not talk to Workspace. It has no Workspace credential and its identity
holds no Workspace admin role.

Ingress is restricted to the load balancer, so a direct `*.run.app` request is
refused by the platform before any application code runs.

### Lifecycle Step Executor (Cloud Run)

The worker. Executes one step per invocation against Workspace, sends every
outbound message, and sweeps the audit mirror.

It is **not behind IAP**, and that is deliberate rather than an oversight. IAP
is a control on human access, and this service has no human ingress path. It is
attached to no load balancer, its ingress is restricted, and it admits exactly
two caller identities, each confined to its own routes:

- The Cloud Tasks queue invoker, on `/tasks/*`
- The API service, on `/lookup/*`

A token issued to either is rejected on the other's routes. The IAM grant cannot
distinguish routes, so that confinement is enforced in the application.

### The network layer: VPC, subnet and Cloud NAT

Small, and present for exactly one reason. The worker's ingress is restricted
to internal traffic, and the API service has to call the worker's lookup routes
for every directory picker and every group membership resolution. A Cloud Run
service with no VPC attachment makes that call over the public internet, where
the worker's own perimeter refuses it before any code runs.

So the API service egresses through a small VPC using Direct VPC egress, which
makes its calls to the worker's run.app address count as internal. With all
traffic routed through the VPC the API loses its default internet route, and it
has one public dependency that Private Google Access does not cover: the IAP
signing keys fetched from www.gstatic.com on a cold start. Cloud NAT restores
that one path. Removing the NAT does not degrade the pickers; it stops anyone
signing in at all.

The worker is deliberately not attached to the VPC. It reaches Google APIs and
the SMTP relay over default egress and has no reason to call another Cloud Run
service. The services still scale to zero; a VPC, a subnet, a router and a NAT
are managed network resources with nothing running in them, so the serverless
constraint holds.

### Cloud Tasks: lifecycle-steps

Step dispatch. At-least-once delivery, which is why every transition is
performed inside a Firestore transaction that refuses illegal transitions: a
duplicate delivery observes a non-ready status and returns without side effects.

Dispatch rate is capped below the Directory API quota. A queue that outruns the
API it drives does not go faster, it generates 429s, which become retries, which
dispatch again.

### Firestore

All durable state and the primary audit trail. See the stores below.

### Cloud Logging: audit bucket

The tamper-evident second copy of the audit trail, with a locked retention
policy. See trust boundaries.

### Secret Manager

Two secrets, and only two. The SMTP relay app password (worker only) and the
credential data-encryption key (worker encrypts, API service decrypts).

### External HTTPS load balancer and IAP

The perimeter. Exactly one backend service exists, and it has IAP enabled. That
is asserted against the committed Terraform, so adding a backend without IAP
fails a test rather than quietly widening the perimeter.

### Google Workspace (Admin SDK Directory)

The system of record for users, groups and org units. Reached by the worker
only, as the service account itself, with a directly assigned Workspace admin
role and no delegation.

### Email delivery: Workspace SMTP relay

Welcome letters and approver notices, through one sender. Not a third-party
provider: mail originates from Company's own domain, so SPF, DKIM and DMARC are
already aligned, which is what decides inbox versus spam.

## Trust boundaries

There are four, and it is worth being precise about which are real.

### 1. The IAP perimeter

Between the internet and the operator surface.

IAP authenticates, and the application **independently verifies** IAP's signed
assertion on every request rather than trusting the perimeter. It checks the
ES256 signature against Google's IAP public keys, the issuer, the exact expected
audience string, and expiry within tolerance. A request without a valid
assertion is rejected before any route handler runs.

Verifying as well as trusting matters because the perimeter can be bypassed if
ingress is ever misconfigured. Both controls are in place, and the ingress
restriction is asserted in the infrastructure tests.

The verified email and sub claims become the request identity. No
client-supplied header or body field can set identity.

### 2. Between the two services

Real, and enforced by IAM plus route-level checks. The API service can reach the
worker's read-only lookup routes and nothing else. It cannot execute steps.

### 3. Between the services and Workspace

Real, and the strongest separation in the system. The worker's identity holds
the custom Workspace admin role; the API service's identity does not. A
compromise of the operator-facing surface cannot mutate the directory.

There is no Domain-Wide Delegation anywhere, no downloaded service-account key,
and no impersonation subject. The worker authenticates as itself using
Application Default Credentials from the Cloud Run metadata server. A
repository-wide scan enforces this over both code and infrastructure.

### 4. Between the services and Firestore: NOT a boundary

Stated plainly because it would be easy to assume otherwise.

Firestore IAM is **database-scoped**, not per-collection. Both services
necessarily hold the same database-level access, and no IAM binding in this
deployment claims otherwise. The API service legitimately writes request and
step documents at creation and on approval.

The boundary between the two services' writes is enforced in the data access
layer, not by IAM, and must not be described as an infrastructure control.

This is also why the audit trail needs the Cloud Logging mirror. Append-only
discipline is a property of the code: nothing in the data access layer updates
or deletes an audit document. But all access is through Admin SDK credentials
that bypass security rules, so anything running as either identity can delete an
audit document, and IAM cannot be narrowed to stop it. Tamper-evidence therefore
has to come from a store the runtime identities cannot rewrite.

Neither runtime identity holds any role permitting log deletion or retention
changes. `logging.logWriter` is the narrowest role that permits writing an entry
and permits nothing else.

There is no Firestore security rules file, and its absence is deliberate. Rules
govern client SDK access and no client SDK touches this database. A rules file
would appear to constrain access and constrain nothing.

## What each store holds

### `lifecycleRequests`

One document per request: phase, status, target user, requester, the payload as
submitted, the **snapshotted approval policy**, and the computed diff for an
update.

The policy snapshot is what stops a later policy edit changing the approval
requirements of a request already in flight.

### `lifecycleRequests/{id}/steps`

One document per plan entry: name, ordinal, status, attempt count, timestamps,
error class and message, the approval decision and its justification, and the
delivery record for notification steps.

This subcollection is the resumability mechanism. State lives here, never in
process memory, so an instance killed mid-step resumes from the last committed
status.

### `auditEvents`

Append-only. Every state change, every authorization refusal, every credential
retrieval attempt, every notification send and suppression.

Each event carries the actor, the action, the target user, before and after
values, an outcome, and a timestamp. Written in the same transaction as the
change it records, so a change cannot exist without its record.

No credential and no message body is ever in here. Redaction is tested.

### `credentialHandoffs`

The one that needs explaining.

The initial password is stored as **ciphertext**, encrypted under the Secret
Manager data-encryption key. Not as a hash.

A hash would be the right choice for a password the system verifies against. It
is the wrong choice here, because the system does not verify this password; it
**hands it to a human once**. An operator has to read the actual characters to
give them to the new joiner. A hash cannot produce them, so a hashed credential
would be a credential nobody could ever use, and the whole handoff would have to
happen through some other channel that this system could not audit.

So it is reversible encryption, and the compensating controls are what make that
defensible:

- Retrieved **exactly once**. The ciphertext is destroyed in the same
  transaction as the read, so two concurrent retrievals yield one success.
- Retrievable **only by the operator who created the request**, checked against
  the IAP-verified identity. Anyone else gets 403.
- A Firestore **TTL** removes the record after 72 hours whether or not anybody
  retrieves it. Firestore performs the removal, so it happens even if the
  application is down or wrong.
- The record carries the **key version** it was encrypted under, so a key
  rotation does not strand it.
- Every attempt, successful or not, is audited.

The plaintext exists in worker memory long enough to set the password in
Workspace and commit the ciphertext, and is discarded. It never appears in a
Firestore document, an API response body, or a log entry, and a test provisions
a user and greps the emitted records for the issued value.

### `roleBindings`

Who holds which role. Individual and group bindings.

A `group` binding grants its roles to every member of the named Google group.
Membership is read live from Workspace through the worker's lookup surface and
cached for a few minutes, so removing somebody from a group revokes the
group-granted roles within the cache window rather than instantly. Removing
their individual binding, or the group's binding, takes effect immediately.

### `approvalPolicy/current`

The live policy. Read at request creation, then snapshotted. Documented in
`docs/approval-policy.md`.

## Scope interpretation: what "roles" means here

**For Company to confirm or correct.**

The requirement is "updating a user's roles/attributes over time". That word is
ambiguous in a Workspace context, and it has been read as:

**In scope.** Group membership, and role-describing user attributes: job title,
department, manager, org unit path, and custom schema fields.

**Out of scope.** Workspace **admin-role assignment**. This application does not
grant, revoke or modify Workspace administrator roles.

The exclusion is not an oversight and not a simplification for time. Managing
admin roles requires the role-management privilege, and a service account
holding it can assign roles **to itself**. That would let a compromise of this
system mint a Super Admin, which is a materially different blast radius from
everything else here: every other capability is bounded by the custom role's
privilege list, and this one is not.

The custom Workspace admin role this system uses deliberately carries no
role-management privilege, and that absence is verified by reviewing the role's
privilege list.

If Company does want admin-role management in scope, it is a change to this
requirement and to the threat model, and should be discussed rather than added.

## How a request flows

1. An operator submits through the console. The client validates using the same
   function the API validates with, so both reject the same payloads. The
   submission goes to the server regardless, and the server's answer is the one
   shown.
2. The API admits it: checks the target is not protected, checks nothing
   conflicting is already in flight, builds the step plan, snapshots the policy,
   and writes the request, its steps and the admission audit event in one
   transaction.
3. The first step is dispatched to Cloud Tasks, or halted in `awaiting_approval`
   if the policy requires it. A halt writes the approver-notification record in
   the same transaction as the halt, so a halt cannot be committed without it.
4. The worker executes one step per invocation. It reads live Workspace state
   before mutating and short-circuits when the intended state already holds.
5. On success it evaluates the next step and either dispatches it or halts it.
6. On a retryable failure the step is retried with backoff. On a terminal
   failure the step fails, the request fails, and no further step is dispatched.
7. A failed request is not a dead end. An admin can resume it from the console
   once the underlying cause is fixed: the failed step returns to ready and is
   re-dispatched, keeping its idempotency key so a replay stays safe and its
   attempt count so the history stays honest.

## Deliberate limitations

Recorded rather than discovered later.

- **Bounces are not observable.** The relay accepts or refuses at submission and
  goes quiet. "Sent" means "accepted by the relay". The system records that
  rather than implying delivery.
- **The audit mirror has a lag.** An event deleted between committing and the
  next sweep reaches neither store and is undetectable. The window is the sweep
  interval.
- **Group-granted roles can be briefly stale.** Membership is cached for a few
  minutes, so removal from a group outlives itself by up to the cache window.
  See `roleBindings` above.
- **Partial phases are not rolled back.** A create that fails at step four
  leaves the first three applied. This is visible in the timeline rather than
  reversed, because an automatic rollback of a partially provisioned account is
  a second mutation sequence that can itself fail halfway.
