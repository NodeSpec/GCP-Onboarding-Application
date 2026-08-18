# Approval policy

Applies to: lifecycle console 0.1.0

Two-party approval is configured per step, per phase. This document lists every
knob, what it does, and two complete worked examples: one where nothing is
gated, and one where every gateable step needs a second person.

## Where the policy lives

The policy is a single Firestore document at `approvalPolicy/current`. It is not
a configuration file and not an environment variable, because REQ-012 gives
admins the ability to change it at runtime and a config artifact would need a
redeploy for that.

The policy is read when a request is created and then **snapshotted onto the
request**. Editing the policy never changes the approval requirements of a
request already in flight. An operator who submits a request and then widens the
policy does not thereby remove the approval their own request is waiting on.

## The shape

```json
{
  "create": { "<step name>": { "requiresApproval": true, "approverRole": "approver", "expiryHours": 48 } },
  "notify": {},
  "update": { },
  "delete": { }
}
```

Each phase maps step names to a policy. A step with no entry needs no approval.
An absent entry is not an error.

## The knobs

### `requiresApproval` (boolean)

Whether the step halts in `awaiting_approval` before it runs. When it halts, an
approver notice is sent (REQ-032) and the request waits.

### `approverRole` (`approver` or `admin`)

Which role a person must hold to decide. `admin` is the narrower of the two.
This is checked server side against the identity IAP verified, so hiding a
button in the console does not affect it.

The requester can never approve their own request, whatever role they hold.

### `expiryHours` (number, optional)

How long the step waits before auto-rejecting. Omit it and the step waits
indefinitely.

Set this with care. An expiry that fires terminates the request in `rejected`
with reason `approval_expired`, which reads in the audit trail like a decision
nobody made. It is useful for requests that stop being safe to apply after a
while; it is a poor fit for offboarding, where the right answer to "nobody
looked" is usually to chase somebody rather than to abandon the request.

## The step names you can gate

Only steps that exist can be gated. Naming a step that is not in the plan has no
effect and no error.

| Phase | Steps, in plan order |
| --- | --- |
| `create` | `validate-request`, `create-user`, `apply-attributes`, `assign-group` (one per group), `verify-account` |
| `notify` | `validate-notify-request`, `confirm-credential` or `regenerate-credential`, `send-welcome-letter` |
| `update` | `validate-update-request`, `compute-update-diff`, `apply-update-attributes`, `add-group` (per group), `remove-group` (per group), `verify-update` |
| `delete` | `suspend-user`, `revoke-access`, `remove-memberships`, `transfer-drive` (when a successor is given), `delete-user` |

## One knob you cannot turn off

`delete-user` always requires approval. The policy can raise the role required,
but it cannot set `requiresApproval` to false, and a policy document that says
otherwise is overridden when it is read.

This is deliberate and it is enforced where policy is read rather than only
where it is written. Deleting a Workspace user is the single action in this
system with no undo: the mailbox, the Drive contents and the identity are gone,
and no compensating step brings them back. A two-party control that one edit to
one document can remove is not a control.

If the policy says nothing at all about `delete-user`, it defaults to requiring
the `admin` role rather than `approver`. Falling through to the wider role would
quietly widen who may authorise the one irreversible thing the system does.

## What is deliberately not gated

`suspend-user`, the first step of offboarding, is not gated by default and
should not be. It is the immediate access cut, and it is the one step in that
phase that can be undone. Putting an approval in front of it would leave a
leaver signed in until an approver happened to be awake, which is the exact risk
offboarding exists to close. The approval belongs on the step nobody can take
back, and that is where it is.

## Example: fully automated

Nothing waits for a second person, except the one step that always does.

```json
{
  "create": {},
  "notify": {},
  "update": {},
  "delete": {}
}
```

Behaviour:

- Creating a user runs end to end with no pause.
- Sending a welcome letter runs with no pause.
- Updating attributes and group membership runs with no pause.
- Offboarding suspends, revokes, removes memberships and transfers Drive with no
  pause, then **halts before `delete-user`** and waits for an `admin`.

That last halt is the floor described above. This is as automated as the system
gets.

## Example: fully two-party

Every gateable step needs a second person, and the destructive phase needs an
admin.

```json
{
  "create": {
    "create-user":      { "requiresApproval": true, "approverRole": "approver" },
    "apply-attributes": { "requiresApproval": true, "approverRole": "approver" },
    "assign-group":     { "requiresApproval": true, "approverRole": "approver" }
  },
  "notify": {
    "send-welcome-letter": { "requiresApproval": true, "approverRole": "approver" }
  },
  "update": {
    "apply-update-attributes": { "requiresApproval": true, "approverRole": "approver" },
    "add-group":               { "requiresApproval": true, "approverRole": "admin" },
    "remove-group":            { "requiresApproval": true, "approverRole": "approver" }
  },
  "delete": {
    "suspend-user":       { "requiresApproval": true, "approverRole": "approver", "expiryHours": 4 },
    "revoke-access":      { "requiresApproval": true, "approverRole": "approver" },
    "remove-memberships": { "requiresApproval": true, "approverRole": "approver" },
    "transfer-drive":     { "requiresApproval": true, "approverRole": "admin" },
    "delete-user":        { "requiresApproval": true, "approverRole": "admin" }
  }
}
```

Two things to notice, because they are the cost of this configuration:

- `assign-group` is one step **per group**. Gating it means an approval per
  group on every onboarding. A five-group onboarding needs five decisions.
- Gating `suspend-user` reopens the window this system exists to close. The four
  hour expiry above limits it, at the price of auto-rejecting an offboarding
  that nobody looked at in time. If you gate this step, someone has to be
  reliably watching the approvals inbox.

## The default, if no policy document exists

A missing document is read as "not configured yet" rather than "approval
intentionally disabled", so the fallback gates the destructive steps:

```json
{
  "create": { "create-user":      { "requiresApproval": false, "approverRole": "approver" } },
  "notify": {},
  "update": { "apply-attributes": { "requiresApproval": true,  "approverRole": "approver" } },
  "delete": { "delete-user":      { "requiresApproval": true,  "approverRole": "admin" } }
}
```

## Changing the policy

Through the console, as an admin. The change takes effect on the next request
created; requests already in flight keep the snapshot they were created with.

Every policy edit is audited with the identity that made it and the before and
after values.
