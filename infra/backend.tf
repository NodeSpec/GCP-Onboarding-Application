# Remote state (docs/cicd.md).
#
# A pipeline and a laptop cannot both hold local state and stay in agreement, so
# once anything applies from CI the state has to live somewhere both can reach.
# Without this the first pipeline run does not update the deployment, it creates
# a second one alongside it and then fails on every name that already exists.
#
# The bucket is deliberately NOT named here. It belongs to whoever deploys this,
# and it is supplied at init time instead:
#
#   terraform init -backend-config="bucket=YOUR_STATE_BUCKET"
#
# State records every value the configuration computed, including ones that are
# uninteresting alone and identifying together. The bucket that holds it wants
# versioning on, uniform bucket-level access on, and no public members. The
# bootstrap in docs/cicd.md creates one that way.
#
# Migrating an existing local state: run the init above once with -migrate-state
# and answer yes. Terraform copies terraform.tfstate into the bucket. Keep the
# local file until you have confirmed a plan against the bucket is empty, then
# delete it, because two copies of state is the problem this file exists to
# prevent.

terraform {
  backend "gcs" {
    prefix = "lifecycle"
  }
}
