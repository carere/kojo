#!/usr/bin/env bash
set -euo pipefail

manifest=${1:?usage: verify-accepted-prerelease.sh MANIFEST}
version=$(jq -er .version "$manifest")
tested_revision=$(jq -er .testedRevision "$manifest")
run_id=$(jq -er '.runId | select(test("^[0-9]+$"))' "$manifest")
release_tag="v$version"

test "$(gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" --json isPrerelease --jq .isPrerelease)" = true
test "$(gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft)" = false
test "$(git rev-list -n 1 "$release_tag")" = "$tested_revision"
# The workflow event SHA precedes the generated version commit. Acceptance is bound to the run
# recorded in the manifest and its successful acceptance job, not a head_sha search.
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id" \
  --jq '.path == ".github/workflows/release.yml" and .event == "workflow_dispatch" and .conclusion == "success"' | grep -qx true
gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?per_page=100" \
  --jq '.jobs[] | select(.name == "Accept Release" and .conclusion == "success") | .id' | grep -q '[0-9]'
bun .github/scripts/release-train.ts verify-published "$manifest"
bun .github/scripts/release-jsr.ts verify "$manifest"
