# Operations runbook

Applies to: lifecycle console 0.1.0

What to do when something is stuck, wrong, or needs changing. Written for
someone on call who did not build this.

## The one thing to know first

Every request is a sequence of steps, each of which is durable, resumable and
idempotent. Nothing is held in memory. If an instance dies mid-step, the next
delivery of that task picks up from the last committed status, and re-running a
step that already did its work is a no-op rather than a second mutation.

That means the answer to most problems is "let it retry" or "retry it", and the
interesting question is usually why it is not retrying.

## Diagnosing a stuck request

Open the request in the console. The step timeline shows every step in plan
order with its status, attempt count, timestamps and error text. Work down it to
the first step that is not `succeeded`.

### The step is `awaiting_approval`

It is not stuck. It is waiting for a person.

Check the approvals inbox as somebody who holds the required role. If the inbox
is empty for everyone who should see it, one of these is true:

- **Nobody holds the role the step requires.** The notification step fails
  loudly with `NoEligibleApprover` rather than reporting a successful send to
  nobody, so look for that on the step. The fix is a role binding, and the
  notification retries afterwards.
- **The only eligible approver is the requester.** Self-approval is prohibited,
  so a request raised by the sole approver waits forever. The fix is a second
  binding.
- **The approver notice failed to send.** The request is still legitimately
  awaiting approval; only the telling failed. It retries. Approve through the
  console directly in the meantime.

If an expiry was configured and has passed, the request terminates in `rejected`
with reason `approval_expired`. That is not a failure to investigate, it is the
configured behaviour. It is also a good reason to reconsider the expiry.

### The step is `running` and has been for a long time

The worker request timeout is `worker_request_timeout_seconds`, ten minutes by
default. A step that has been `running` for materially longer than that means
the instance died without settling it.

It will recover: the task is redelivered, the executor observes the step is not
claimable by this attempt, and the retry proceeds. Wait one queue backoff
interval before doing anything.

### The step is `failed`

Read the error class on the step. It tells you what kind of problem it is.

| Class | Means | What to do |
| --- | --- | --- |
| `retryable` | A transient failure. A 429, a 5xx, a quota pause, a connection reset. The step will be retried automatically until its attempt budget is spent. | Nothing, unless the budget is spent. Then look at what is rate limiting you. |
| `terminal` | The operation cannot succeed however many times it is tried. The address already exists, the group does not exist, the successor account for a Drive transfer is the account being deleted. | Fix the underlying condition, then raise a new request. Retrying will not help. |
| `validation` | The request payload is wrong. Caught before anything mutates. | Raise a corrected request. Nothing was changed. |
| `permission` | The worker's identity was refused by Workspace. Almost always the custom admin role is missing a privilege, or was never assigned to the service account. | See `docs/workspace-admin-setup.md`. The error names the missing privilege. |

A `permission` error appearing suddenly on a system that used to work usually
means somebody edited the custom admin role.

### The whole request is `failed`

A step exhausted its retry budget. The request stops; no subsequent step is
dispatched. Earlier steps that succeeded stay succeeded, which is deliberate:
partial onboarding is visible rather than rolled back into an unknown state.

Read the failing step, fix the cause, and raise a fresh request. The phases are
idempotent, so re-running a create against a partially created account completes
what is missing rather than failing on what is already there.

## Resuming a request

A running request needs no help. Resumption is what the queue does: a retryable
step retries on its own schedule until its budget is spent.

Once the budget is spent the request is `failed`, and an **admin can resume it
from the request detail view**. Fix the underlying cause first, because a resume
re-runs the same step with the same inputs: a resumed step keeps its idempotency
key, so a replay against work that already landed skips rather than repeats, and
it keeps its attempt count, so the history never pretends the failure did not
happen. The resume is audited with who did it and what state it moved.

Resume when the cause was environmental: a missing admin-role privilege since
granted, a relay that was refusing mail, a quota that has recovered. Raise a new
request instead when the payload itself was wrong, because a resume re-runs the
same payload and a corrected request needs a fresh plan and a fresh policy
snapshot.

If a task was lost entirely (the queue was purged, say), resume the request; the
resume re-dispatches the step.

## Cancelling a request

An operator can cancel a request that has not reached a terminal state, through
the console, with a reason.

**Cancelling an offboarding does not simply stop it.** If the request has
already suspended the account, cancellation dispatches a **compensating
unsuspend step**, and the request moves to `compensating` rather than
`cancelled`. It stays in flight until the unsuspend succeeds.

This distinction matters on call. `compensating` means the account is being put
back and is not yet usable. `cancelled` means the request is finished. The
console says which; do not report the account restored until the request reaches
`cancelled`.

If the compensating step itself fails, it retries like any other step. If it
exhausts its budget, the account is left suspended and somebody has to unsuspend
it in the Admin console by hand. That is the one case in this system where
manual Workspace intervention is the answer.

## The credential handoff

A created account's one-time password is stored as ciphertext and retrievable
**exactly once**, by the operator who raised the request.

- A second retrieval returns 410 and the ciphertext is already gone.
- A retrieval by anyone else returns 403.
- A retrieval after 72 hours returns 410; Firestore removed the record.

There is no way to recover a password after any of those. The remedy is a notify
request with `regenerate` set, which sets a fresh password and invalidates the
old one. That resets a password the person may already be using, so ask first.

The welcome letter itself carries no password and no claim link. Google's own
first sign-in flow sets the password, which is why this application hosts no
password page and every route stays behind IAP.

## Protected accounts

Some Workspace accounts are load-bearing for this system, most pointedly the
no-reply account whose app password sends every welcome letter. A delete request
against it would silently break onboarding for everyone.

A create, update or delete request targeting a protected address is refused at
admission with 409 and a typed `ProtectedAccount` error. No request document and
no step document is written. The refusal is audited with the operator, the
account and the action attempted.

**An admin is refused exactly as a requester is.** This is not a permission
level to escalate past.

### What is protected by default

- The SMTP sender account (`SMTP_SENDER`).
- The Return-Path monitoring group (`SMTP_RETURN_PATH`).

Matching is case insensitive and covers aliases, plus-tags and dot variants, so
a protected account cannot be reached through an alternate spelling of its
address.

### Amending the list

The list is read from configuration and changes without a code release. Set
`PROTECTED_ACCOUNTS` on the API service to a comma separated list of addresses;
it is added to the defaults rather than replacing them.

**Keep it tight.** An over-broad list silently blocks legitimate offboarding,
and the failure mode is an operator being told they may not delete a leaver with
no obvious reason why. Protect accounts the system itself depends on. Do not
use this as a general "important people" list; that is what the approval policy
is for.

One addition is worth making deliberately: the break-glass administrator
accounts, including the bootstrap admin from `BOOTSTRAP_ADMINS`. Nothing stops
two operators from offboarding the tenant's last working administrator through
this system, and the two-party approval that guards deletion does not guard
against two people agreeing to a mistake. Listing those accounts here closes
that door without touching the approval policy.

Review the list whenever the notification path changes. Moving to a different
sending account without updating this leaves the old one protected and the new
one exposed.

## Rotating the SMTP app password

1. Generate a new app password on the no-reply Workspace account.
2. Add it as a new version of `notification-smtp-credentials`.
3. Do nothing else. No redeploy, no restart.

The sender caches the password it authenticated with. On an authentication
refusal it drops the cached connection, re-reads the secret at `versions/latest`
and retries once, so the first send after a rotation succeeds with the new
password. A second refusal gives up rather than looping, because at that point
the credential is wrong rather than stale and retrying would be an
authentication storm against the relay.

Disable the old version once you have seen a letter go out.

## Rotating the credential encryption key

This one has a drain step, and skipping it strands data.

Credential records store the key **version** they were encrypted under, and the
worker decrypts with that version rather than with `latest`. So ciphertext
written under the old version keeps decrypting for as long as that version is
enabled.

1. Add the new version.
2. **Leave the previous version enabled for at least 72 hours**, the credential
   TTL. Any handoff written before the rotation is still retrievable in that
   window.
3. Disable the previous version.

Disabling early makes every un-retrieved password from before the rotation
permanently unreadable. Those accounts need a regenerate.

## Bounced welcome letters

The Workspace SMTP relay accepts or refuses at submission and then goes quiet.
There is no webhook and no event stream, so "sent" means "accepted by the relay"
and nothing more. The system records that limitation on the step rather than
implying delivery it cannot observe.

Asynchronous bounces go to the Return-Path group (`SMTP_RETURN_PATH`).
**Somebody has to be reading it.** Name that person or rota here:

> Bounce mailbox owner: _to be filled in by Company_

A letter that vanished after acceptance has one remedy, which is a resend from
the request detail view. The address is editable there, because the commonest
reason a letter did not arrive is that the address was wrong.

## The audit trail

Every state change writes an audit event in the same Firestore transaction as
the change itself, so a change cannot exist without its record.

That trail is mirrored to a Cloud Logging bucket with a locked retention policy.
The mirror runs on a schedule, sweeping committed events into the log keyed on
the same event id, and a reconciliation check compares the two stores over a
window in both directions:

- **Present in Firestore, missing from the log**: the mirror is behind or
  broken. Operational, not a security event. Check the scheduler job and the
  sweep's most recent run.
- **Present in the log, missing from Firestore**: an audit record was deleted
  from the store the application can write to. This is the condition the whole
  control exists to make visible. Escalate.

There is a window between an event committing and the sweep carrying it across,
five minutes by default, in which a deletion would reach neither store and be
undetectable. That is the honest limit of the control.

## Escalation

| Symptom | First check |
| --- | --- |
| Nobody can sign in | Certificate status, then whether `iap_audience` matches the deployed backend service |
| Everybody is authorized for nothing | Role bindings, then `BOOTSTRAP_ADMINS` |
| Every Workspace call fails with `permission` | The custom admin role assignment on the worker service account |
| No letters are going out | The SMTP secret, then the relay's sender and recipient settings |
| Letters fail with SMTP 421 at EHLO | The relay is refusing the connection before authentication. Confirm the relay admits by SMTP authentication rather than by IP address; the worker has no fixed egress IP by design. New relay settings can take hours to propagate and new source IPs are greylisted, so the step's automatic retries often clear this on their own. |
| Offboarding fails at `revoke-access` with `permission` | The custom admin role is missing Security, User Security Management. See `docs/workspace-admin-setup.md`. |
| Steps queue but never run | The queue's run.invoker bindings, then the worker's ingress setting |
| Audit reconciliation reports Firestore missing entries | Escalate. Do not investigate alone. |
