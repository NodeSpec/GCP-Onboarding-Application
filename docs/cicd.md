# Continuous integration and deployment

Two workflows in `.github/workflows`.

`ci.yml` runs on every push and every pull request. It builds, typechecks, runs
the unit and emulator suites, and runs `terraform fmt -check` and `terraform
validate`. It uses no credentials at all, so it runs on a pull request from a
fork and still says something useful.

`deploy.yml` runs on a push to `main`. It builds both images, pushes them to
Artifact Registry, resolves each to a digest, and applies the infrastructure
pointing at those digests. After it is set up, shipping a change is a merge.

Setting this up is a one-time job and it is all below. Do
`docs/deployment.md` first: the pipeline updates a deployment, it does not
replace the first one, and several of the steps here need values that only
exist after Terraform has run once.

## What the pipeline does not do

Worth knowing before you rely on it.

It does not touch the Workspace tenant. Admin roles, the SMTP relay, SPF and
DKIM, and the service account role assignment are all
`docs/workspace-admin-setup.md`, and none of them have an API Terraform can
call. A change there is still done by hand.

It does not put values into Secret Manager. Both secrets are created empty and
filled once, out of band, so that no secret value passes through Terraform state
or a workflow log. Rotation is the same operation and is also not automated.

It does not create the DNS record, and it does not wait for the certificate.

## 1. The state bucket

The pipeline and your laptop cannot both keep local state and stay in
agreement. `infra/backend.tf` declares a GCS backend with no bucket name in it;
the name is supplied at init.

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1
export STATE_BUCKET="${PROJECT_ID}-lifecycle-tfstate"

gcloud storage buckets create "gs://${STATE_BUCKET}" \
  --project "$PROJECT_ID" \
  --location "$REGION" \
  --uniform-bucket-level-access \
  --public-access-prevention

gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
```

Versioning is not optional in spirit. State is the only record of what is
deployed, and a bad apply that corrupts it is recoverable from a previous
version and not otherwise.

### Migrating the state you already have

If you have already applied from Cloud Shell, your state is a local file. Move
it once:

```bash
cd infra
terraform init -backend-config="bucket=${STATE_BUCKET}" -migrate-state
```

Answer yes. Terraform copies the local state into the bucket. Then confirm the
move worked before you throw anything away:

```bash
terraform plan
```

An empty plan means the bucket holds a full and correct picture of the
deployment. Once you have seen that, delete the local `terraform.tfstate` and
`terraform.tfstate.backup`. Two copies of state is the failure this is
preventing, and keeping the old one "just in case" is how you get it.

## 2. The deployer identity

```bash
gcloud iam service-accounts create lifecycle-deployer \
  --display-name="Lifecycle CI deployer" \
  --project "$PROJECT_ID"

export DEPLOYER="lifecycle-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
```

Say plainly what this identity is. It creates service accounts and grants them
project roles, so it holds `roles/resourcemanager.projectIamAdmin`, and anything
that can grant a role can grant itself any role. It is a project administrator.
Writing out the individual roles rather than granting `roles/owner` is still
worth doing, because the list is then a statement of what the deployment
actually touches and an added role is a reviewable change, but do not read it as
a privilege boundary. The boundary is that only a push to `main` in one named
repository can assume it, which is step 3.

```bash
for role in \
  roles/run.admin \
  roles/compute.networkAdmin \
  roles/compute.loadBalancerAdmin \
  roles/compute.securityAdmin \
  roles/iap.admin \
  roles/iap.settingsAdmin \
  roles/datastore.owner \
  roles/cloudtasks.admin \
  roles/cloudscheduler.admin \
  roles/secretmanager.admin \
  roles/logging.admin \
  roles/iam.serviceAccountAdmin \
  roles/iam.serviceAccountUser \
  roles/artifactregistry.writer \
  roles/serviceusage.serviceUsageAdmin \
  roles/resourcemanager.projectIamAdmin \
  roles/storage.admin
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER}" \
    --role="$role" \
    --condition=None \
    --quiet
done
```

`roles/storage.admin` is for the state bucket. If you would rather scope it,
grant `roles/storage.objectAdmin` on that one bucket instead and drop it from
the project list.

## 3. Workload Identity Federation

This is what makes the pipeline work with no key file. GitHub mints a
short-lived OIDC token describing the workflow run; GCP is configured to trust
tokens from GitHub that carry the right repository claim, and trades one for an
access token. Nothing long-lived is created, so nothing long-lived can leak.

```bash
gcloud services enable iamcredentials.googleapis.com --project "$PROJECT_ID"

gcloud iam workload-identity-pools create github \
  --project "$PROJECT_ID" --location=global \
  --display-name="GitHub Actions"
```

**The attribute condition below is the security control, not a detail.** Without
it, the provider trusts any GitHub Actions token from any repository on GitHub,
and any stranger's workflow can assume your deployer. Set `GITHUB_REPO` to your
own `owner/repo` before running this.

```bash
export GITHUB_REPO=your-org/your-repo

gcloud iam workload-identity-pools providers create-oidc github \
  --project "$PROJECT_ID" --location=global \
  --workload-identity-pool=github \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '${GITHUB_REPO}'"
```

Then let that repository, and only that repository, impersonate the deployer:

```bash
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" \
  --project "$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_REPO}"
```

Print the provider resource name. It goes into the repository variables:

```bash
echo "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github"
```

## 4. Repository variables

Everything specific to your deployment lives here rather than in the repository.
Set them under **Settings > Secrets and variables > Actions > Variables**.

These are variables, not secrets. None of them is confidential, and a variable
is readable in the run log, which is what you want when a deploy goes wrong. No
password, key or token appears in either workflow.

| Variable | Example | Where it comes from |
|---|---|---|
| `GCP_PROJECT_ID` | `lifecycle-prod` | your project |
| `GCP_PROJECT_NUMBER` | `123456789012` | `gcloud projects describe` |
| `GCP_REGION` | `us-central1` | your choice, matching the first deploy |
| `WIF_PROVIDER` | `projects/123.../providers/github` | printed at the end of step 3 |
| `DEPLOYER_SA` | `lifecycle-deployer@PROJECT.iam.gserviceaccount.com` | step 2 |
| `TF_STATE_BUCKET` | `lifecycle-prod-lifecycle-tfstate` | step 1 |
| `CONSOLE_DOMAIN` | `lifecycle.example.com` | your DNS |
| `OPERATOR_GROUP` | `lifecycle-operators@example.com` | your Workspace tenant |
| `IAP_SUPPORT_EMAIL` | `you@example.com` | shown on the consent screen |
| `SMTP_SENDER` | `no-reply@example.com` | the sending account |
| `SMTP_RETURN_PATH` | `lifecycle-bounces@example.com` | may be empty |
| `WORKSPACE_CUSTOMER_ID` | `my_customer` | leave as `my_customer` unless you have a reason |
| `BOOTSTRAP_ADMINS` | `you@example.com,other@example.com` | comma separated, no spaces |
| `AUDIT_BUCKET_LOCKED` | `true` | `true` or `false`, unquoted |

`AUDIT_BUCKET_LOCKED` is read as JSON, so it must be exactly `true` or `false`.
Locking is irreversible; `docs/deployment.md` says what that commits you to. It
and `WORKSPACE_CUSTOMER_ID` fall back to `true` and `my_customer` if you leave
them unset, so the two you can reasonably skip are the two with a safe default.

`BOOTSTRAP_ADMINS` is split on commas, and empty entries are dropped, so a
trailing comma is harmless and an empty variable produces an empty list.

## 5. Gating the apply, if you want to

`deploy.yml` declares `environment: production`. Declaring it changes nothing on
its own. If you would rather an apply not happen unattended, open **Settings >
Environments > production** and add yourself as a required reviewer. Every
deploy then waits for a human, and no workflow file changes.

Worth doing on a deployment with real users in it. Skip it while you are still
iterating.

## 6. Try it

Push to `main`, or run the workflow by hand from the Actions tab. The run
summary ends with the image digests it deployed and the console URL.

Rolling back is a digest that is still in the registry. Find the run that
deployed the good one, take its digest from the summary, and set it directly:

```bash
gcloud run services update lifecycle-api \
  --image "REGION-docker.pkg.dev/PROJECT/lifecycle/api@sha256:..." \
  --region "$REGION" --project "$PROJECT_ID"
```

That is deliberately a manual command rather than a workflow. It also drifts
from Terraform, so follow it by reverting the commit and letting the pipeline
put the two back in agreement.

## How the worker URL is handled

The worker needs its own URL, and that URL contains a generated hash, so it does
not exist until the worker does. `docs/deployment.md` handles this by having you
apply twice.

The pipeline does it for you. Before applying it reads `worker_service_url` out
of the existing state and passes it in; after applying it reads it again, and if
it changed, applies once more. On the first run that is two applies. On every
run after it is one, because the value is already correct.

## Troubleshooting

**`Error: failed to retrieve credentials` or a permission denied immediately
after the auth step.** The attribute condition does not match. It compares
`assertion.repository` against `owner/repo` exactly, and it is case sensitive.

**`Error acquiring the state lock`.** A previous run was cancelled mid-apply.
Check that nothing is actually running, then `terraform force-unlock LOCK_ID`
with the id from the error.

**The apply fails on `google_iap_brand`.** A project holds exactly one OAuth
brand and creating one is awkward for a service account. Create it once from
Cloud Shell as yourself, per `docs/deployment.md`, and let the pipeline take it
from there. Importing an existing brand is in that guide too.

**The apply fails on `Group ... does not exist`.** `OPERATOR_GROUP` names a
group that is not in the tenant. The pipeline cannot create it; Workspace groups
are not GCP resources.

**A push to `main` did not trigger anything.** `deploy.yml` has to be present on
`main` itself. A workflow added on a branch does not run until it is merged.
