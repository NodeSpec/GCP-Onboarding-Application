# Google Workspace admin setup

Applies to: lifecycle console 0.1.0

The tenant-side configuration that lets the worker's service account act as a
Workspace administrator **without Domain-Wide Delegation**.

This is done in the Workspace Admin console, not in Terraform. Workspace admin
roles are not GCP resources. The one part that is infrastructure as code is
enabling the Admin SDK API, which `infra/apis.tf` does.

Do this after `terraform apply`, because you need the worker's service account
email, which is a Terraform output.

## Why not Domain-Wide Delegation

The customer's constraint, and worth understanding rather than just following.

Domain-Wide Delegation lets a service account **impersonate any user in the
domain**, including super admins. The grant is made by OAuth client id against a
scope list, and once made, anything holding that service account's credentials
can act as anyone. It is also easy to over-grant and hard to audit: the
delegation list shows a client id and a scope string, not what is actually being
done with it.

The alternative used here is to give the service account its own admin
authority. It authenticates as itself, holds a custom admin role carrying only
the privileges the four phases need, and impersonates nobody. Every action in
the Workspace audit log is attributable to the service account rather than to
some user it borrowed.

The application enforces its half of this: no impersonation subject anywhere in
the auth path, no downloaded key file, and a repository-wide scan over both code
and infrastructure that fails if either appears.

## What you need

- Super Admin on the Workspace tenant.
- The worker's service account email:

  ```bash
  cd infra && terraform output -raw worker_service_account
  ```

  It looks like `lifecycle-worker@your-project-id.iam.gserviceaccount.com`.

## Step 1: Confirm app passwords are available

Do this **first**. If app passwords are disabled in the tenant, the SMTP relay
design does not work and the notification path has to change before you build
anything on it.

1. Admin console, **Security > Authentication > 2-step verification**
2. Confirm 2-step verification is available and can be enforced for the sending
   account.
3. **Security > Access and data control > Less secure apps** and the
   organizational unit settings for the sending account: confirm app passwords
   are not blocked.

App passwords require 2-step verification on the account, and Google has been
progressively restricting them. If they are unavailable, stop here and choose
between the relay's IP-allowlisting path or an external mail provider. Both are
larger changes than they sound.

## Step 2: Create the no-reply sending account

A dedicated Workspace account that sends every welcome letter and approver
notice.

1. **Directory > Users > Add new user**
2. Create `no-reply@yourdomain.com`, or similar.
3. Give it **no admin role**. It sends mail; it administers nothing.
4. Enrol it in 2-step verification.
5. Generate an app password for it: sign in as that account,
   **myaccount.google.com > Security > 2-Step Verification > App passwords**.
6. Put the app password into Secret Manager as described in
   `docs/deployment.md`. Do not write it down anywhere else.

It belongs to no person on purpose. Offboarding a human should never break
onboarding for everyone else.

This account is on the protected-account list by default, so the system refuses
lifecycle requests against it. See `docs/runbook.md`.

Create the Return-Path group at the same time: **Directory > Groups**, named to
match the `smtp_return_path` value in your Terraform variables, for example
`lifecycle-bounces@yourdomain.com`. Asynchronous bounces land there, and a
person has to be reading it; the runbook has a line for naming who. It is on
the protected-account list by default, like the sender.

## Step 3: Configure the SMTP relay

1. **Apps > Google Workspace > Gmail > Routing > SMTP relay service**
2. Add a relay setting:
   - **Allowed senders**: only addresses in my domains
   - **Authentication**: require SMTP authentication, and accept the no-reply
     account. Also enable **Only accept mail from the specified IP addresses**
     and add the deployment's reserved egress address:

     ```bash
     cd infra && terraform output -raw smtp_egress_ip
     ```

   - **Encryption**: require TLS encryption

The IP registration is not optional hardening. The relay judges connections by
source address, and it tarpits sources it does not recognise with a 421 at
EHLO, before authentication is ever offered, so a correct password cannot save
an unregistered sender. The worker routes all outbound mail through one
reserved Cloud NAT address (`infra/network.tf`) so there is exactly one address
to register, and it never changes. Relay setting changes can take a few hours
to propagate; the queue's automatic retries carry a pending letter across that
window.

The welcome letter goes to a **personal address outside the domain**, so the
relay must permit any recipient. That is the default for the relay service, but
confirm it: a relay restricted to internal recipients will accept the connection
and refuse every letter that matters.

## Step 4: Configure SPF, DKIM and DMARC

Mail from the relay originates from your own domain, which is the whole reason
this is preferable to a third-party provider: alignment is already possible.

1. **Apps > Google Workspace > Gmail > Authenticate email** for DKIM. Generate
   the key and publish the TXT record.
2. Publish or confirm SPF, including `include:_spf.google.com`.
3. Publish or confirm DMARC.

Then **send a real letter to a real external address and confirm it lands in the
inbox, not spam**. This is not a formality. A misaligned domain produces mail
that is accepted by the relay, reported as sent, and never read, and the system
cannot observe the difference.

## Step 5: Create the custom admin role

The narrow part. Grant only what the four phases use.

1. **Account > Admin roles > Create new role**
2. Name it `Lifecycle Service Account`, or similar. Describe it as being for the
   lifecycle worker service account only.
3. Under **Admin API privileges**, select exactly:

   **Users**
   - Read
   - Create
   - Update
   - Delete

   **Groups**
   - Read
   - Update (this is what permits managing members)

   **Organizational Units**
   - Read

   **Security**
   - User Security Management

   **Data Transfer**
   - Manage data transfers (only if you use the Drive transfer step in
     offboarding; omit it otherwise)

4. Select **nothing else**. In particular:

   - No **Services** privileges
   - No **Domain Settings**
   - No other **Security** privileges beyond User Security Management
   - No **Reports**
   - **No role-management privilege of any kind**

That last exclusion is the important one. A role carrying role-management
privilege lets the service account assign roles **to itself**, which means a
compromise of this system could mint a Super Admin. Every other capability here
is bounded by this privilege list; that one is not.

User Security Management is what permits the offboarding phase to revoke a
leaver's OAuth tokens at the revoke-access step. Suspension alone is not a
session cut: tokens issued before the suspension keep working against some
surfaces, so the revocation is a stated requirement rather than tidiness.
Google gates the token endpoints behind this privilege and behind their own
API scope, and an earlier version of this guide excluded all Security
privileges, which made the first real offboarding fail at revoke-access with
a 403 naming the missing privilege. The rest of the Security section stays
unselected.

Organizational Units is **read only** deliberately. The system places users into
existing org units and never creates, moves or deletes them.

### Verify the privilege list

Before assigning it, open the role and read its privileges back. This is
REQ-027 AC-3 and it is worth doing with your eyes rather than assuming the
checkboxes did what you meant.

Confirm the list contains only the privileges above, and confirm there is no
entry mentioning roles, role assignment, or admin management.

## Step 6: Assign the role to the service account

Not to a user. To the service account, by email.

1. **Account > Admin roles**
2. Open the role you created.
3. **Assign service accounts**
4. Paste the worker service account email from Terraform:
   `lifecycle-worker@your-project-id.iam.gserviceaccount.com`
5. Assign.

Assign it to **that account and nothing else**. Not to the API service account,
which must hold no Workspace admin role. Not to a human.

If **Assign service accounts** is not offered, the role carries a privilege that
cannot be held by a service account. Go back and re-check the list; something
outside Admin API privileges got selected.

## Step 7: Confirm Domain-Wide Delegation is NOT configured

1. **Security > Access and data control > API controls**
2. **Manage Domain Wide Delegation**
3. Confirm there is **no entry** for this service account's OAuth client id.

There should be nothing to remove, because nothing in this system creates one.
Check anyway. This is the constraint the whole design exists to satisfy, and a
delegation entry added by someone else for some other purpose would silently
undermine it.

To find the client id if you need to check against it:

```bash
gcloud iam service-accounts describe \
  lifecycle-worker@your-project-id.iam.gserviceaccount.com \
  --format='value(oauth2ClientId)' --project "$PROJECT_ID"
```

## Step 8: Verify the grant is live

Prove the read path works before exercising anything that mutates a real
account.

The worker exposes a read-only lookup surface used by the console's pickers.
Sign in to the console and open the new-request form: if the target-user search
returns results and the group and org-unit pickers are populated, the grant is
live and the Directory API is answering.

That is the intended verification, because it goes through exactly the path the
application uses.

If you want to check without the console, impersonating the service account
requires `roles/iam.serviceAccountTokenCreator` on it, which nothing in this
deployment grants by default. Granting it temporarily to yourself to run a
one-off `users.list` is reasonable; leaving it granted is not.

## Troubleshooting

**Every Workspace call fails with a `permission` error.**
The role is not assigned, or is assigned to the wrong principal. Re-check step 6.
The application surfaces a typed `AdminRoleNotGranted` error naming the missing
privilege rather than a generic API failure, so read the step error text.

**User operations work, group operations fail.**
Groups **Update** was not selected. Read alone permits listing members and not
changing them.

**Offboarding fails at the revoke-access step with a permission error.**
Security > **User Security Management** was not selected, which is exactly what
an older version of this guide instructed. Add that single privilege to the
role and resume the failed request; the role edit takes a few minutes to
propagate. The rest of the Security section stays unselected.

**Every letter fails with SMTP 421 at EHLO, and retries do not clear it.**
The relay does not trust the source address. Confirm the reserved egress
address (`terraform output -raw smtp_egress_ip`) is in the relay setting's
allowed IP list, exactly as step 3 describes, and allow a few hours for a
recent settings change to propagate. Because the refusal happens before
authentication, no credential or sender setting can be the cause.

**The Drive transfer step fails.**
Data Transfer privilege was not selected, or the Data Transfer API is not
enabled. If you do not use Drive transfer, remove `transferDriveTo` from delete
requests rather than granting the privilege.

**Org unit assignment fails.**
The path does not exist. The system places users into existing org units and
does not create them; create it in the Admin console first.

**Nothing works, and the service account looks correct.**
Confirm the Admin SDK API is enabled on the GCP project. Terraform does this,
but a project where somebody disabled it by hand will fail exactly this way:

```bash
gcloud services list --enabled --project "$PROJECT_ID" | grep admin.googleapis.com
```

## Summary of what was granted

| What | Where | Value |
| --- | --- | --- |
| SMTP relay allowed IP | Gmail > Routing > SMTP relay service | The reserved egress address from `terraform output -raw smtp_egress_ip`, with authentication and TLS still required |
| Custom admin role | Account > Admin roles | Users read/create/update/delete; Groups read/update; Org Units read; Security user security management; Data Transfer manage |
| Assigned to | Assign service accounts | The worker runtime service account, by email |
| Assigned to anything else | | Nothing |
| Domain-Wide Delegation | Security > API controls | None, confirmed absent |
| Role-management privilege | | None, confirmed absent |
