#!/bin/sh
# Run from the checked-out repository through Coolify's custom start command.
# Only staging Compose is used. Existing credentials remain in Coolify's .env.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'Usage: sh deploy/staging-upgrade.sh STAGING_PROJECT STAGING_RESOURCE_DIRECTORY' >&2
  exit 2
fi
stage_project=$1
stage_directory=$2
case "$stage_project" in ''|*[!a-z0-9_-]*) echo 'Invalid staging project' >&2; exit 2;; esac
if [ "$stage_directory" != "/data/coolify/applications/$stage_project" ]; then
  echo 'Staging resource directory does not match project' >&2
  exit 2
fi
compose() {
  docker compose --project-name "$stage_project" --project-directory "$stage_directory" \
    -f deploy/compose.staging.yaml --env-file .env "$@"
}
# Pull before interrupting staging. Each failure prevents all subsequent steps.
compose pull api worker migrate
compose stop --timeout 45 api worker
compose run --rm --no-deps migrate
compose run --rm --no-deps api bun scripts/backfill-grant-eligibility.ts
compose up -d api worker
