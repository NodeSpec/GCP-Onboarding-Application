# Deployment guide

Applies to: lifecycle console 0.1.0

Standing this system up in an empty GCP project. Follow it in order; several
steps depend on outputs from earlier ones.

Read `docs/workspace-admin-setup.md` alongside this. The GCP side and the
Workspace side both have to be done, and neither works without the other.

## What you need before you start

- A GCP project, and the project **number** as well as the project id. The
  number appears in the IAP audience string the application verifies against.
- Billing enabled on the project. Cloud Run, Cloud Tasks and the load balancer
  all require it.
- `roles/owner` or an equivalent combination on the project. Provisioning
  touches IAM, IAP, service enablement and Firestore.
- A Google Workspace tenant you are a super admin of, for the Workspace side.
- A domain you control, and the ability to create a DNS A record for it.
- A Google group for operators. Not a list of people: access is granted and
  revoked by group membership, with no deployment in the loop.
- Terraform 1.9 or later.
- Docker, and an Artifact Registry repository to push two images to.

## 1. Enable the APIs

Terraform enables everything the system needs, but it cannot enable the API it
needs to enable APIs. Do this one by hand:

```bash
gcloud services enable cloudresourcemanager.googleapis.com --project "$PROJECT_ID"
```

Everything else, including the Admin SDK, is declared in `infra/apis.tf` and
enabled by the apply.

## 2. Build and push the images

Both images are referenced **by digest**, never by tag. A tag is a mutable
pointer: the same Terraform state would describe different running code
depending on when it was applied, and a rollback would have nothing exact to
roll back to. The Terraform refuses a tag at plan time.

```bash
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/lifecycle"

npm ci
npm run build

docker build -f services/api/Dockerfile    -t "$REGISTRY/api:build"    .
docker build -f services/worker/Dockerfile -t "$REGISTRY/worker:build" .

docker push "$REGISTRY/api:build"
docker push "$REGISTRY/worker:build"

# The digests are what you put in the tfvars.
gcloud artifacts docker images describe "$REGISTRY/api:build"    --format='value(image_summary.digest)'
gcloud artifacts docker images describe "$REGISTRY/worker:build" --format='value(image_summary.digest)'
```

Note that the console is built into the API image. `npm run build` produces
`services/api/public/`, which the API service serves behind IAP. There is no
separate static bucket, and that is the point: the console shares an origin with
the API, so the browser's IAP cookie is the only credential in play.

## 3. Write the variables

Create `infra/terraform.tfvars`:

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
```

Two of these are worth pausing on.

`bootstrap_admins` is the only way into an empty role-binding store. Without it
nobody can reach the admin routes and nobody can grant anybody else a role.
Put yourself in it, grant real bindings through the console once you are in, and
then consider whether to remove yourself.

`audit_bucket_locked` defaults to `true` and **locking is irreversible**. Once
applied, the audit log bucket's retention cannot be shortened and the bucket
cannot be deleted until every entry has aged out, by anyone, including a project
owner. That is exactly the property the requirement asks for. If you are
applying this into a scratch project you intend to delete, set it to `false`.

## 4. Apply

```bash
cd infra
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

The first apply takes a while. The managed TLS certificate is the slow part and
will sit in `PROVISIONING` until DNS resolves, which is the next step.

Record the outputs:

```bash
terraform output
```

## 5. Point DNS at the load balancer

```bash
terraform output -raw console_ip
```

Create an A record for your domain against that address. The managed
certificate cannot issue until the record resolves, and the console is
unreachable until the certificate is active. Fifteen minutes to an hour is
normal; several hours is not unheard of.

Check progress:

```bash
gcloud compute ssl-certificates describe lifecycle-console-cert \
  --global --format='value(managed.status)'
```

## 6. Set up the IAP OAuth brand and client

Terraform provisions both (`google_iap_brand`, `google_iap_client`), so in most
cases there is nothing to do here. Two things can go wrong:

**A brand already exists in the project.** A project can hold only one OAuth
brand, and it cannot be deleted. If the apply fails on
`google_iap_brand.console`, import the existing one rather than trying to create
a second:

```bash
gcloud alpha iap oauth-brands list --project "$PROJECT_ID"
terraform import google_iap_brand.console projects/$PROJECT_NUMBER/brands/$BRAND_ID
```

**The support email is rejected.** It must be your own address or a Google group
you belong to. It appears on the consent screen.

The client id is a Terraform output, not something to copy out of the console:

```bash
terraform output -raw iap_client_id
```

## 7. Grant operator access

Access is `roles/iap.httpsResourceAccessor` on the backend service, granted to
the operator group by Terraform. You do not grant it per person.

To give someone access, add them to the group. To take it away, remove them.
Neither needs a deployment or a Terraform apply, and revocation takes effect on
their next request.

```bash
gcloud identity groups memberships add \
  --group-email="lifecycle-operators@example.com" \
  --member-email="newjoiner@example.com"
```

Being admitted by IAP is not the same as being able to do anything. IAP decides
who reaches the application; role bindings decide what they may do once there.
A person in the operator group with no role binding is authenticated and
authorized for nothing, which is the intended state for someone who should be
able to look but not act.

## 8. Populate the secrets

Both secrets are created **empty**. No secret value appears in the Terraform
configuration or in Terraform state, because a value passed through a variable
is written to state in plaintext and state is a file people copy around.

The credential encryption key. 32 bytes from a cryptographic source, base64
encoded:

```bash
openssl rand -base64 32 | tr -d '\n' | \
  gcloud secrets versions add credential-encryption-key --data-file=- --project "$PROJECT_ID"
```

Generate it on a machine you trust and do not write it to disk on the way. The
command above pipes it directly.

The SMTP app password, from the Workspace side (see
`docs/workspace-admin-setup.md`):

```bash
printf '%s' "$APP_PASSWORD" | \
  gcloud secrets versions add notification-smtp-credentials --data-file=- --project "$PROJECT_ID"
```

Adding a version does not require redeploying either service. Both resolve their
secrets at runtime, and the SMTP sender re-reads on an authentication failure so
a rotation is picked up without a restart.

## 9. Set the approval policy

The system runs without one, on a default that gates the destructive steps. To
configure it deliberately, sign in as a bootstrap admin and edit it through the
console. `docs/approval-policy.md` documents every knob with worked examples.

## 10. Verify

In this order, because each one depends on the last:

```bash
# The platform refuses a direct request. This SHOULD fail.
curl -s -o /dev/null -w '%{http_code}\n' "$(terraform output -raw api_service_url)"
# Expect 403 or a connection failure. A 200 means ingress is wrong.

# The perimeter is up and asking for authentication.
curl -s -o /dev/null -w '%{http_code}\n' "https://$(terraform output -raw console_url | sed 's|https://||')"
# Expect a redirect to the Google sign-in flow.
```

Then in a browser:

1. Visit the console URL. You should be sent to Google sign in.
2. Sign in as a member of the operator group. You should reach the console.
3. Sign in as someone outside the group. You should be refused at the perimeter
   and never reach the application.
4. As a bootstrap admin, confirm the console names you and lists your roles.
5. Submit a create request against a test address and watch the step timeline.

If step 5 fails at `create-user` with a permission error, the Workspace side is
not done. Go to `docs/workspace-admin-setup.md`.

## Redeploying

Build, push, take the new digests, update the tfvars, apply. Cloud Run shifts
traffic to the new revision.

Rolling back is the same operation with the previous digest, which is why the
digests are worth keeping somewhere other than your shell history.

## What a destroy will and will not remove

`terraform destroy` leaves two things standing on purpose:

- **The Firestore database.** It holds every request, step and audit event in
  the system. It is created with delete protection and an `ABANDON` deletion
  policy.
- **The audit log bucket**, if `audit_bucket_locked` was true. A locked
  retention policy cannot be removed and the bucket cannot be deleted until
  every entry has aged out. This is the control working as designed.
