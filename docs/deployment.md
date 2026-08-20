# Deployment guide

Applies to: lifecycle console 0.1.0

Standing this system up in an empty GCP project, from nothing to a working,
IAP-protected console.

Follow it in order. Several steps consume values that only exist after an
earlier one, and the Workspace side needs a service account identity that does
not exist until Terraform has run.

Everything here is copy and paste. Set the variables in step 1 and the rest of
the guide pastes without editing, except for five values in step 5 that are
specific to your organisation and are marked where they appear.

Read `docs/workspace-admin-setup.md` alongside this. The GCP side and the
Workspace side both have to be done, and neither works without the other.

Do this by hand once. After it works, `docs/cicd.md` turns the mechanical half
of it into two GitHub Actions workflows, and shipping a change becomes a merge.

## What you need before you start

- A GCP project, and its project **number** as well as its project id. The
  number appears in the IAP audience string the application verifies against.
- Billing enabled on the project. Cloud Run, Cloud Tasks and the load balancer
  all require it.
- `roles/owner` or an equivalent combination on the project. Provisioning
  touches IAM, IAP, service enablement and Firestore.
- A Google Workspace tenant you are a super admin of.
- **At least one spare Workspace licence.** The create phase provisions a real
  user, which consumes a seat. A tenant with no free seat cannot complete an
  onboarding request. See "Workspace licences" below, because this one catches
  people out late.
- A domain you control, and the ability to create a DNS A record for it.
- A Google group for operators. Not a list of people: access is granted and
  revoked by group membership, with no deployment in the loop.

### Workspace licences

Worth deciding before you start, because two things compete for the same seats.

A production deployment wants a dedicated no-reply account to send from, so that
offboarding a human never breaks onboarding. That account consumes a licence.
Every user the system creates also consumes one.

If you are evaluating on a small tenant, the pragmatic split is to send from
your own admin address and keep the spare seat free for the create phase to use.
You give up the dedicated sender, which is a production hygiene property rather
than anything that changes whether the code is correct. Set `smtp_sender` to
your own address in step 5, and the create, notify, update and delete phases all
work against a single spare seat, because the delete phase hands the licence
back when it finishes.

### Custom admin roles

The design assigns the worker a **custom** Workspace admin role carrying only
the privileges the four phases need. Custom admin roles are gated by Workspace
edition. Before you begin, open the Admin console and check that
**Account > Admin roles > Create new role** exists and is clickable.

If it is not available, the deployment still works, but you have to assign
prebuilt roles (User Management Admin and Groups Admin) to the service account
instead. That is broader than least privilege and does not satisfy REQ-027 AC-2.
It does preserve the property the architecture exists for, which is that no
Domain-Wide Delegation is configured and the service account acts as itself.
Record the difference rather than leaving it implicit.

## 1. Set your variables

Everything below reads from these. Set them once per shell session; they do not
survive a new Cloud Shell tab.

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/lifecycle"

gcloud config set project "$PROJECT_ID"

# Both must print a value before you continue.
echo "PROJECT_ID=$PROJECT_ID  PROJECT_NUMBER=$PROJECT_NUMBER"
```

If you know the project by its display name rather than its id, resolve it:

```bash
gcloud projects list --filter="name='Your Project Name'" --format='value(projectId)'
```

## 2. Install the tools

Cloud Shell already has `gcloud`, `git`, `docker` and Node.js. It no longer
ships Terraform.

Install it into your home directory rather than through `apt`, because a Cloud
Shell session is rebuilt regularly and only your home directory persists:

```bash
TF_VERSION=1.9.8
cd ~
wget -q "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip"
unzip -o "terraform_${TF_VERSION}_linux_amd64.zip" -d ~/bin
rm "terraform_${TF_VERSION}_linux_amd64.zip"

export PATH="$HOME/bin:$PATH"
grep -qxF 'export PATH="$HOME/bin:$PATH"' ~/.bashrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc

terraform version   # expect v1.9.8 or later
```

Then clone the repository:

```bash
cd ~
gh auth login          # GitHub.com, HTTPS, browser
gh repo clone YOUR_ORG/gcp-onboarding-application
cd gcp-onboarding-application
```

Directory names are case sensitive. Use the name `gh` reports when it finishes
cloning.

## 3. Enable the APIs

Terraform declares every API the system needs in `infra/apis.tf`, and enabling
them is part of the apply. Do it here anyway, with `gcloud`, and do it first.

The reason is ordering. `gcloud services enable` blocks until each API is
actually live, while Terraform enables an API and immediately tries to create
resources against it. On a fresh project that race fails the first apply with
`SERVICE_DISABLED` on Compute Engine and a scatter of related errors. Enabling
up front removes the race entirely.

```bash
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  compute.googleapis.com \
  run.googleapis.com \
  iap.googleapis.com \
  firestore.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  logging.googleapis.com \
  iam.googleapis.com \
  artifactregistry.googleapis.com \
  admin.googleapis.com \
  --project "$PROJECT_ID"
```

The IAP service agent, which earlier versions of this guide had you provision
here with `gcloud beta services identity create`, is now a Terraform resource
(`google_project_service_identity.iap` in `infra/iap.tf`), so there is nothing
more to do in this step.

## 4. Build and push the images

Both images are referenced **by digest**, never by tag. A tag is a mutable
pointer: the same Terraform state would describe different running code
depending on when it was applied, and a rollback would have nothing exact to
roll back to. The Terraform refuses a tag at plan time.

Create the registry and authenticate Docker to it:

```bash
gcloud artifacts repositories create lifecycle \
  --repository-format=docker --location="$REGION" --project "$PROJECT_ID" || true

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
```

Build and push. The API image is removed locally between the two builds because
Cloud Shell's disk is small and both images are large:

```bash
docker build -f services/api/Dockerfile -t "$REGISTRY/api:build" .
docker push "$REGISTRY/api:build"
docker image rm "$REGISTRY/api:build"

docker build -f services/worker/Dockerfile -t "$REGISTRY/worker:build" .
docker push "$REGISTRY/worker:build"
```

If Cloud Shell runs out of disk or the session dies during this step, it is not
recoverable by retrying: both images together do not fit. Build on a machine
with Docker and roughly 10 GB free, or set up `docs/cicd.md` and let the deploy
workflow build them on a GitHub runner.

Capture the digests. These go into the Terraform variables:

```bash
export API_DIGEST=$(gcloud artifacts docker images describe "$REGISTRY/api:build"    --format='value(image_summary.digest)')
export WORKER_DIGEST=$(gcloud artifacts docker images describe "$REGISTRY/worker:build" --format='value(image_summary.digest)')

# Both lines must end in a sha256 value, not a bare @.
echo "api    = $REGISTRY/api@$API_DIGEST"
echo "worker = $REGISTRY/worker@$WORKER_DIGEST"
```

The console has no deployment of its own. `npm run build` inside the API image
produces `services/api/public/`, which the API service serves behind IAP. There
is no separate static bucket, and that is the point: the console shares an
origin with the API, so the browser's IAP cookie is the only credential in play.

If a push fails with `connection refused`, that is Cloud Shell's network rather
than anything about the image. Run the push again; Docker resumes and only sends
what did not arrive.

## 5. Write the variables file

`infra/terraform.tfvars` is your deployment, not part of the repository. It is
ignored by git, and no tfvars file is tracked.

This writes it, filling in everything the earlier steps produced. **Five values
are yours to set** and are marked. Four are edited by hand; the customer id is
filled in by the command substitution, and after the `cat` at the end it must
read like `C01ab2cd3`, not `my_customer` and not an empty string:

```bash
cat > infra/terraform.tfvars <<EOF
project_id     = "$PROJECT_ID"
project_number = "$PROJECT_NUMBER"
region         = "$REGION"

api_image    = "$REGISTRY/api@$API_DIGEST"
worker_image = "$REGISTRY/worker@$WORKER_DIGEST"

# ---- SET THESE FIVE FOR YOUR ORGANISATION ----
domain                = "lifecycle.example.com"
operator_group        = "lifecycle-operators@example.com"
iap_support_email     = "you@example.com"
smtp_sender           = "no-reply@example.com"
workspace_customer_id = "$(gcloud organizations list --format='value(owner.directoryCustomerId)')"
# ----------------------------------------------

smtp_return_path = "lifecycle-bounces@example.com"
bootstrap_admins = ["you@example.com"]

# Locking is IRREVERSIBLE. Leave it true for a real deployment. Set it false
# for a scratch project you intend to delete, or you will pin years of logs to
# a project nobody can remove.
audit_bucket_locked = true
EOF

cat infra/terraform.tfvars
```

Four of these are worth pausing on.

`workspace_customer_id` must be the tenant's REAL customer id. The Directory
API's `my_customer` alias means "the customer the authenticated user belongs
to", and this system's worker is a service account acting as itself, which
belongs to no Workspace customer. With the alias, every customer-scoped
Directory call fails with a bare `400 Bad Request` that names nothing. The
Terraform refuses the alias at plan time for exactly that reason. It is also in
the Admin console under **Account > Account settings > Profile > Customer ID**.

The command substitution above exists so the value is never typed. A customer id
mixes digits and letters, and `1` against `l` is the same glyph in most fonts;
one deployment lost an evening to a hand-copied id that differed from the real
one by exactly that character, and the validation cannot catch it because the
transposed id is still shaped like a customer id.

`bootstrap_admins` is the only way into an empty role binding store. Without it
nobody can reach the admin routes and nobody can grant anybody else a role. Put
yourself in it, grant real bindings through the console once you are in, then
decide whether to remove yourself.

`operator_group` must be a group that **already exists** in your Workspace
tenant. IAP validates it at apply time and refuses a group it cannot find.
Create it in the Admin console under Directory > Groups before you apply, and
add yourself to it.

`audit_bucket_locked` defaults to true and **locking is irreversible**. Once
applied, the audit log bucket's retention cannot be shortened and the bucket
cannot be deleted until every entry has aged out, by anyone, including a project
owner. That is exactly the property REQ-018 asks for. For a scratch project, set
it to false.

One variable is missing on purpose. `worker_url` cannot be known until the
worker exists, so you add it after the first apply. Step 6 covers it.

## 6. Apply

State lives in a GCS bucket, and `infra/backend.tf` deliberately does not name
it. Create one and pass it at init:

```bash
export STATE_BUCKET="${PROJECT_ID}-lifecycle-tfstate"

gcloud storage buckets create "gs://${STATE_BUCKET}" \
  --project "$PROJECT_ID" --location "$REGION" \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning

cd infra
terraform init -backend-config="bucket=${STATE_BUCKET}"
terraform plan -out=tfplan
terraform apply tfplan
```

Versioning matters more than it looks. State is the only record of what is
deployed, and an apply that corrupts it is recoverable from a previous version
and not otherwise.

The first apply creates about 70 resources and takes several minutes.

On Cloud Shell, reduce the concurrency. Terraform's default of ten parallel
operations opens enough simultaneous connections to trigger sporadic
`connection refused` and `cannot assign requested address` failures against
Google's APIs:

```bash
terraform apply -parallelism=3
```

Those errors are transient and harmless. Run the apply again and it continues
from where it stopped. If the same read keeps failing, skip the refresh, since
those reads are Terraform re-checking resources it has already created:

```bash
terraform apply -parallelism=3 -refresh=false
```

Record the outputs:

```bash
terraform output
```

### Apply a second time to set the worker URL

The worker needs to know its own URL. It is the audience the worker checks
incoming task tokens against, and the address it posts follow-on steps to. That
URL is not knowable before the service exists, because Cloud Run puts a
generated hash in it, and Terraform will not let the worker resource reference
itself. So it is a variable you fill in after the first apply.

Until you do, the worker runs with `https://worker-url-not-set.invalid`. Every
task it receives is rejected with a 401 and no request ever leaves the
`queued` state. Read the URL back and apply again:

```bash
cd infra
WORKER_URL=$(terraform output -raw worker_service_url)
echo "worker_url = \"$WORKER_URL\"" >> terraform.tfvars
terraform apply -parallelism=3
```

The second apply changes one environment variable on one service, so it takes
under a minute. Confirm it landed:

```bash
gcloud run services describe lifecycle-worker \
  --region "$REGION" --project "$PROJECT_ID" \
  --format=yaml | grep -A2 WORKER_BASE_URL
```

The value must be the worker's own `run.app` URL. If it is your console domain
or the `.invalid` placeholder, `worker_url` did not make it into
`terraform.tfvars`.

### The IAP OAuth brand and client

Terraform provisions both (`google_iap_brand` and `google_iap_client`), so
usually there is nothing to do here. The client id is a Terraform output rather
than something to copy out of the console:

```bash
terraform output -raw iap_client_id
```

Two things can go wrong.

**A brand already exists in the project.** A project can hold only one OAuth
brand, and it cannot be deleted. If the apply fails on
`google_iap_brand.console`, import the existing one rather than trying to create
a second:

```bash
gcloud alpha iap oauth-brands list --project "$PROJECT_ID"
terraform import google_iap_brand.console "projects/$PROJECT_NUMBER/brands/BRAND_ID"
```

**The support email is rejected.** `iap_support_email` must be your own address
or a Google group you belong to. It appears on the consent screen users see.

You will also see a deprecation warning on `google_iap_brand` at plan time.
Google has deprecated the IAP OAuth Admin API that backs it. The resource still
applies today; if a future apply fails outright on brand creation, switch the
backend service to IAP's Google-managed OAuth by enabling IAP without an
explicit client id and secret, and drop the brand and client resources.

## 7. Point DNS at the load balancer

```bash
terraform output -raw console_ip
```

Create an A record for the host part of your `domain` against that address. For
`lifecycle.example.com` that is a record whose host is `lifecycle`, not `@` and
not `www`.

Check the saved record reads exactly `lifecycle.example.com`. Some DNS providers
append the domain to whatever you type, which turns a full name into
`lifecycle.example.com.example.com` and prevents the certificate from ever
issuing.

Verify from a shell rather than from the provider's interface:

```bash
dig +short lifecycle.example.com     # expect the console_ip value
```

The managed certificate cannot issue until that resolves, and the console is
unreachable until the certificate is active. Fifteen minutes to an hour is
normal:

```bash
gcloud compute ssl-certificates describe lifecycle-console-cert \
  --global --project "$PROJECT_ID" --format='value(managed.status)'
```

`PROVISIONING` becomes `ACTIVE`. If it becomes `FAILED_NOT_VISIBLE`, Google
tried and could not see the record, which is almost always the doubled suffix
above.

## 8. Do the Workspace side

Terraform cannot do any of this. Workspace admin roles are not GCP resources.

Follow `docs/workspace-admin-setup.md` in full. The shape of it:

1. Create the no-reply sending account, or decide to send from your own address
   as described under "Workspace licences". Enrol it in 2-step verification and
   generate an app password.
2. Configure the SMTP relay to allow that sender and to permit **any**
   recipient, since welcome letters go to personal addresses outside the domain.
   Register the deployment's reserved egress address in the relay's allowed IP
   list, keeping SMTP authentication and TLS required:

   ```bash
   terraform output -raw smtp_egress_ip
   ```

   This is not optional hardening. Without the address registered, the relay
   treats every connection from the worker as a stranger and tarpits it with
   421 at EHLO, before authentication is ever offered, and no credential or
   sender setting can clear that.
3. Configure SPF and DKIM, then send one real letter to an external address and
   confirm it lands in the inbox rather than spam.
4. Create the custom admin role carrying only Users read, create, update and
   delete; Groups read and update; Organizational Units read; and Data Transfer
   only if you use Drive transfer. **No role-management privilege of any kind.**
5. Assign it to the worker service account, by email, under
   **Account > Admin roles > Assign service accounts**:

   ```bash
   terraform output -raw worker_service_account
   ```

6. Confirm **Security > API controls > Manage Domain Wide Delegation** contains
   no entry for that service account. There should be nothing to remove. Check
   anyway.

Role assignments take a few minutes to propagate. A permission error immediately
after assigning is usually impatience rather than a mistake.

## 9. Populate the secrets

Both secrets are created **empty**. No secret value appears in the Terraform
configuration or in Terraform state, because a value passed through a variable
is written to state in plaintext and state is a file people copy around.

The credential encryption key, 32 bytes from a cryptographic source, generated
straight into Secret Manager so it never touches disk:

```bash
openssl rand -base64 32 | tr -d '\n' | \
  gcloud secrets versions add credential-encryption-key --data-file=- --project "$PROJECT_ID"
```

The SMTP app password from the Workspace side. `read -rs` keeps it off the
screen and out of shell history:

```bash
read -rs APP_PASSWORD
printf '%s' "$APP_PASSWORD" | \
  gcloud secrets versions add notification-smtp-credentials --data-file=- --project "$PROJECT_ID"
unset APP_PASSWORD
```

Remove the spaces if Google displayed the app password in groups of four.

Adding a version does not require redeploying either service. Both resolve their
secrets at runtime, and the sender re-reads on an authentication failure, so a
rotation is picked up without a restart.

## 10. Grant operator access

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
who reaches the application; role bindings decide what they may do once there. A
person in the operator group with no role binding is authenticated and
authorized for nothing, which is the intended state for someone who should be
able to look but not act.

## 11. Set the approval policy

The system runs without one, on a default that gates the destructive steps. To
configure it deliberately, sign in as a bootstrap admin and edit it through the
console. `docs/approval-policy.md` documents every knob with worked examples.

## 12. Verify

In this order, because each depends on the last.

**The platform refuses a direct request.** This one is expected to fail:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$(terraform output -raw api_service_url)"
```

Expect **404**, 403, or a connection failure. Any of those is a pass. A 404 is
the usual answer: the services are deployed with ingress restricted to the load
balancer, so Google's front end refuses the request before it reaches the
service and does not confirm anything is there. **A 200 is a finding**, and
means the perimeter is bypassable.

Repeat it against `worker_service_url`, which should behave the same way.

That 404 is the perimeter refusing *you*. It is worth knowing that the API
service is subject to the same rule when it calls the worker, which is why the
API is given VPC egress in `infra/network.tf`. Without it the API gets this same
404 on every directory lookup and the worker never sees the request.

**The perimeter asks for authentication:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$(terraform output -raw console_url)"
```

Expect a redirect into the Google sign-in flow.

Then in a browser:

1. Visit the console URL. You should be sent to Google sign in.
2. Sign in as a member of the operator group. You should reach the console.
3. Sign in as someone outside the group. They should be refused at the perimeter
   and never reach the application.
4. As a bootstrap admin, confirm the console names you and lists your roles.
5. Open the new-request form. If the target-user search returns results and the
   group and org-unit pickers populate, **the Workspace grant is live** and the
   whole Directory read path works. This is the verification for REQ-027 AC-6.
6. Submit a create request against a test address and watch the step timeline.

If step 5 shows empty pickers, or step 6 fails at `create-user` with a
permission error, the Workspace side is not done. Go to
`docs/workspace-admin-setup.md`.

The full live walkthrough, including credential retrieval, two-party approval,
cancellation and the audit mirror, is in the README.

## Troubleshooting

Every item here is something that happened during a real first deployment.

**`terraform` is not installed.** Cloud Shell no longer bundles it. Step 2.
Install to `~/bin` rather than through `apt`, which does not survive a session
rebuild.

**`Error: Cycle:` naming iap_audience, the Cloud Run service and the backend
service.** Fixed in the configuration. If you see it, your checkout predates the
fix; pull the latest `main`.

**`SERVICE_DISABLED` on Compute Engine, or a scatter of API errors on the first
apply.** Terraform enabled the APIs during the same run and raced itself. Step 3
prevents it. If you are already here, run step 3 and apply again.

**`Service account service-PROJECT_NUMBER@gcp-sa-iap.iam.gserviceaccount.com
does not exist`.** The IAP service agent has not been provisioned. Current
checkouts provision it in Terraform (`infra/iap.tf`) and the invoker grant
waits for it, so seeing this means the checkout predates that change. Pull, or
run `gcloud beta services identity create --service=iap.googleapis.com
--project "$PROJECT_ID"` once by hand.

**`Group ... does not exist`** on the IAP binding. `operator_group` names a group
that is not in the tenant, or was created seconds ago and has not propagated.
Create it, wait a few minutes, apply again.

**`connection refused`, `cannot assign requested address`, or a failure reading
a resource that plainly exists.** Cloud Shell drops outbound connections under
Terraform's default concurrency of ten. The failure lands on whichever resource
happened to be reading at the time, which is why it looks like a different
problem each run and never the same one twice.

Nothing in the configuration causes it and nothing in the configuration can fix
it. Lower the concurrency and retry the whole command rather than watching it:

```bash
for attempt in 1 2 3 4 5; do
  terraform apply -parallelism=3 -input=false && break
  echo "attempt $attempt failed; retrying in $((attempt * 10))s"
  sleep $((attempt * 10))
done
```

Add `-refresh=false` if the same read keeps dying and you know the state is
current. The durable fix is not to apply from Cloud Shell at all: the deploy
workflow runs on a GitHub runner, which does not have this problem, and
`docs/cicd.md` is that setup.

**`docker push` fails partway with `connection refused`.** The same flakiness.
Run the push again; it resumes.

**Docker builds exhaust Cloud Shell, or the session dies mid-build.** Cloud
Shell has a 5 GB home directory and a small VM, and each image installs the
whole workspace before compiling it. Two of them back to back will not fit.
Build somewhere else: a machine with Docker and roughly 10 GB free, or the
deploy workflow, which builds both images on a GitHub runner.

**Every plan reports `0 to add, 2 to change` on the two Cloud Run services, and
applying does not clear it.** Cloud Run reports a service-level `scaling` block
on every service whether or not one was declared, so Terraform proposes removing
something that cannot be removed, forever. Both services now carry
`lifecycle { ignore_changes = [scaling] }`, which ends it; seeing this means the
checkout predates that change, so pull. The scaling that this deployment does
manage is inside `template` and is untouched by the ignore.

**`Warning: Deprecated Resource` on `google_iap_brand`.** Expected, and not a
failure. The IAP OAuth Admin API is deprecated, so the provider warns on every
plan. An existing brand keeps working and the resource keeps managing it; there
is no replacement resource to move to yet. Ignore it.

**`"/package-lock.json": not found` during a docker build.** The Dockerfiles in
the current `main` install with `npm install` and need no lockfile, so this
error means the checkout predates that change. Pull, or generate one with
`npm install --package-lock-only --no-audit --no-fund` from the repository root.

**`gcloud builds submit --config -` fails with `Unable to read file [-]`.** That
`gcloud` cannot take a build config on stdin. Write the config to a file and
pass its path.

**The certificate never leaves `PROVISIONING`, or shows `FAILED_NOT_VISIBLE`.**
DNS does not resolve to `console_ip`. Check for a doubled domain suffix in the
record. Step 7.

**The console loads but the pickers are empty.** Two different causes, and the
worker's logs tell you which in one query:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="lifecycle-worker" AND jsonPayload.message="directory lookup failed"' --project="$PROJECT_ID" --limit=5 --freshness=15m --format='table(timestamp,jsonPayload.operation,jsonPayload.status,jsonPayload.err)'
```

If you get rows with **status 403**, the Workspace custom role is not assigned
to the worker service account, or is missing Users read. Step 8, item 5, and
give it a few minutes to propagate.

If you get **no rows at all**, the request is not reaching the worker. Check the
API service's own request log for `/api/lookup`:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="lifecycle-api" AND httpRequest.requestUrl:"/api/lookup"' --project="$PROJECT_ID" --limit=5 --freshness=15m --format='table(timestamp,httpRequest.status,httpRequest.requestUrl)'
```

A **404** there, with nothing on the worker, means the API is calling the worker
over the public internet and the worker's ingress restriction is refusing it
before any code runs. Confirm the API service has a network interface:

```bash
gcloud run services describe lifecycle-api --region "$REGION" --project "$PROJECT_ID" --format=yaml | grep -iA3 "network-interfaces\|vpc-access"
```

If that prints nothing, the VPC in `infra/network.tf` was never applied. Pull
the latest `main` and apply. This one is worth recognising on sight, because a
404 looks like a missing route and sends you reading application code that is
fine.

**Every directory lookup fails with `400 Bad Request`, with the admin role
correctly assigned.** The worker is calling the Directory API with
`workspace_customer_id` unset or set to `my_customer`, which a service account
cannot use. Step 5 explains why and how to set the real customer id. Current
checkouts refuse the alias at plan time, so this only reaches runtime on a
checkout that predates the validation.

**A create request fails at `create-user` with a quota error.** The tenant has no
free Workspace licence. See "Workspace licences".

**Every welcome letter fails with `SMTP 421` at EHLO, retrying forever.** The
relay is refusing the connection before authentication, so no credential or
sender setting is involved: it does not trust the source address. The worker
sends through the deployment's reserved egress address, and that address must be
registered in the relay's allowed IP list in the Admin console. Step 8, item 2.
If the worker service has no network interface (check with the `gcloud run
services describe` command above, against `lifecycle-worker`), the checkout
predates the egress change; pull the latest `main` and apply. Relay setting
changes can take a few hours to propagate, and the step's automatic retries
carry it across that window.

**A request is approved and then nothing happens. It sits at `queued` and no
step ever runs.** The worker is rejecting its own tasks. Check `WORKER_BASE_URL`
on the worker service: it must be the worker's own `run.app` URL. If it is
`https://worker-url-not-set.invalid`, you have not done the second apply in
step 6. If it is your console domain, your checkout predates the fix; pull the
latest `main` and then do the second apply.

**A list that will not load, with `9 FAILED_PRECONDITION: The query requires an
index`.** A composite index on `lifecycleRequests` is missing. Every index the
application needs is declared in `infra/firestore.tf`, so the first thing to
check is that your checkout is current and that the apply succeeded:

```bash
gcloud firestore indexes composite list --project="$PROJECT_ID" \
  --format="table(name.basename(),state,fields[].fieldPath.list())"
```

An index in `CREATING` is not a fault, it is not finished. They take a few
minutes on an empty database and longer on a full one.

If one is genuinely absent, the full error text names it. Firestore's message
ends in a console link that encodes the exact fields, and that link is the
authoritative answer to which index is wanted:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND textPayload:"FAILED_PRECONDITION"' \
  --project="$PROJECT_ID" --limit=1 --format='value(textPayload)'
```

## Redeploying

Do this once by hand, then stop doing it by hand. `docs/cicd.md` sets up the two
GitHub Actions workflows in this repository, after which a merge to `main`
builds both images, pushes them, and applies. Everything in this guide that is
mechanical is in those workflows; everything that is not, mainly the Workspace
tenant and the secret values, stays here because it has no API to call.

By hand: build, push, take the new digests, update the tfvars, apply. Cloud Run
shifts traffic to the new revision.

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
