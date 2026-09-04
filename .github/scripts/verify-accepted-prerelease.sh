#!/usr/bin/env bash

set -euo pipefail

manifest=${1:?usage: verify-accepted-prerelease.sh <release-manifest>}
version=$(jq -er .version "$manifest")
tested_revision=$(jq -er .testedRevision "$manifest")
release_tag="v$version"

test "$(gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" --json isPrerelease --jq .isPrerelease)" = true
test "$(gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft)" = false
test "$(git rev-list -n 1 "$release_tag")" = "$tested_revision"

accepted=false
run_ids=$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/prerelease.yml/runs?head_sha=$tested_revision&status=success&per_page=100" --jq '.workflow_runs[].id')
for run_id in $run_ids; do
  accepted_jobs=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/$run_id/jobs" --jq '[.jobs[] | select(.name == "Accept the prerelease" and .conclusion == "success")] | length')
  if [ "$accepted_jobs" -gt 0 ]; then
    accepted=true
    break
  fi
done
test "$accepted" = true

bun .github/scripts/release-train.ts verify-published "$manifest"
bun .github/scripts/release-train.ts verify-active-tags "$manifest"
