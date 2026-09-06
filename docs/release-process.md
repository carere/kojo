# Release process

Use **GitHub → Actions → release → Run workflow**. Select **main** and enter the exact new version.
The workflow creates the version commit and tags, validates the package set, and publishes it.
You do not need to run local version or publication commands.

Select `dry_run` to run preparation and validation without changing remote commits, tags, or packages.
A dry run does not test registry write permissions. The next run must use the same source to validate
that version again before publication.

## Stages and evidence

| Stage | Example | Required accepted predecessor | Full Host evidence | npm tags after acceptance |
| --- | --- | --- | --- | --- |
| Alpha | `0.1.0-alpha.1` | None for the first alpha | No | `alpha`, `next` |
| Beta | `0.1.0-beta.1` | Alpha or an earlier beta in the same version line | Yes | `beta`, `next` |
| Release Candidate | `0.1.0-rc.1` | Beta or an earlier RC in the same version line | Yes | `rc`, `next` |
| Stable | `0.1.0` | RC in the same version line | Yes | `latest`, `next` |

The workflow selects the newest accepted predecessor. It checks that predecessor's GitHub Release,
workflow result, tag, npm archive integrity. Mutable npm tags do not prove
acceptance. A stable version permits only version metadata and Release notes after its accepted RC.
Any code change requires another RC.

Every version checks TypeScript, Biome, Knip, packages, unit tests, and integration tests.
The Console build and types are checked in CI. Test the UI manually while it is under active
development; browser automation is paused until the UI is stable. Moon can reuse valid cached test
results; release workflows do not force test execution.
Beta, RC, and stable also run native systemd, shipped systemd, and shipped macOS evidence.
The complete evidence index must accept every required check at the prepared version commit.
Normal pull request and main CI run the core checks; they do not run full Host evidence.
CLI integration tests run in eight shards on separate Hosts in CI and Release checks. Every shard
must pass. Full Release evidence combines all eight logs before checking the named test results.

Automated release evidence excludes UI-01, UI-02, UI-03, and RELEASE-02 while browser testing is
deferred. ACCESS-04 retains Artifact publication integration coverage. These UI checks are not
reported as passed; the maintainer checks UI changes manually during development.

## Registry package sets

npm receives two coordinated packages:

- `@carere/kojo-runtime`
- `@carere/kojo` (the CLI and Console)

`kojo-client-contracts` and `kojo-runner-contracts` stay private workspace packages. Release
preparation copies client and Runner contract source into `kojo`, and Runner contract source into
`kojo-runtime`. It changes contract imports to relative paths and removes private dependencies
from the prepared manifests. Workspace source and imports do not change. Contract packages keep
their own tests and build tasks, but have no new registry versions or Release tags.

npm is the only deployment target. The Runtime keeps its TypeScript entry points and static
Runtime manifest.

## Authentication setup

These settings are maintained through npm and GitHub websites:

- GitHub Actions secret `RELEASE_GITHUB_TOKEN`: a fine-grained user token for this repository with
  **Contents: read and write**. Its owner must be allowed to bypass the protected `main` rule.
  Checkout uses it to push the validated version commit and three tags atomically.
- GitHub Actions secret `NPM_TOKEN`: the initial alpha bootstrap used a granular token with
  read/write access and bypass 2FA to create the four packages. npm rejected this credential for
  tag removal. The current tag steps need a supported authentication path before another release;
  see **Recovery after alpha.1** below.
- npm Trusted Publisher on `kojo` and `kojo-runtime`: GitHub owner `carere`, repository `kojo`, workflow
  filename `release.yml`, with no environment restriction. The publication job has `id-token: write`.
  After the initial alpha creates the packages, configure these publishers before the next Release.
- GitHub environment `npm-production`: required reviewers before stable npm promotion in the
  acceptance job. The `npm-prerelease` environment must not require a reviewer if prereleases
  should run unattended.
  Keep `NPM_TOKEN` available as a repository Actions secret because candidate cleanup also needs it.

Each npm publication uses exactly one credential method. Existing package sets use npm Trusted
Publishing. The script exchanges GitHub OIDC for a short-lived, package-specific npm credential
through the [npm Registry API](https://api-docs.npmjs.com/), then passes it to `bun publish`.
An OIDC failure stops publication; it does not fall back to `NPM_TOKEN`.

Bun's publisher does not generate npm provenance attestations in this setup. The GitHub Release
manifest binds tested archives to their commit and workflow run. Authentication and provenance
are separate properties.

As of September 2026, bypass-2FA tokens can still publish directly. npm plans to remove that ability
around January 2027. The initial-package bootstrap must then move to the supported staged or
interactive approval process. See the [npm deprecation notice](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/).

## What the workflow does

1. Prepare the coordinated version with Cocogitto in a clean checkout. This updates both public package
   versions, the lockfile, and the Runtime manifest. It creates the global `vVERSION`
   tag and two `PACKAGE@vVERSION` tags. A Git bundle gives each job the exact prepared commit.
2. Run the required checks. Pack the npm archives once. Shipped Host checks use these archives.
3. After all checks pass, verify that remote `main` has not moved, then push the version commit and
   tags. Publish the npm archives with the `candidate` tag. Check their public integrity and protect
   `latest` from an unaccepted version, including a partially published first package set.
4. Install the exact public npm versions on Linux and macOS. For stable, wait for the
   `npm-production` reviewer before acceptance and tag promotion.
5. Recheck public content, promote npm tags,
   and create the accepted GitHub Release with its manifest. Full-evidence stages also attach the
   complete Host evidence archive.

After acceptance, test another system with the exact installation command in the workflow summary:

```bash
bun add -g @carere/kojo@0.1.0-alpha.1
kojo daemon install
```

On each test system, run `kojo ui`. Check Project and Workflow lists, Start and Stop actions,
Run details, Gate answers, and reconnect behavior after a Daemon restart. Record the package
version, Host, and result with each UI issue. These manual checks are separate from CI acceptance.

To install the Runtime in a Factory Project:

```bash
bun add --exact @carere/kojo-runtime@0.1.0-alpha.1
```

## Failed runs

Do not reuse a published version. If publication is partial, fix the failure and launch `release`
with a higher sequence number. A partially published candidate is not an accepted predecessor.
Do not delete or move published tags to make a failed version appear valid.

A failure before the remote push leaves no remote version changes. Fix the issue and launch the
workflow again. If `main` moved during validation, start a new run against current `main`.

After publication, a failed install, evidence check, or promotion blocks acceptance.
Inspect the failing job and its artifacts. Registry publication is not transactional across the two npm
packages: some packages can exist while the Release remains unaccepted. Dist-tag promotion restores
its previous tag snapshot if a write fails. A failure while creating the GitHub Release can occur
after promotion; inspect registry tags before starting a replacement version.

The old `prerelease.yml` entry point is removed. All stages use `release.yml`.

## Recovery after alpha.1

The first publication uploaded all four npm packages, but release acceptance failed. Full npm
metadata exposes their versions and integrity values; the abbreviated install view returned 404.
Release scripts now request full metadata for registry checks.

The `NPM_TOKEN` used for bootstrap has bypass 2FA enabled. npm refused its attempt to remove
`latest` with HTTP 403. This token is not a verified credential for the tag-management steps above.
Those steps must be corrected before another publication. Configure Trusted Publishing for the two public
packages for subsequent uploads; do not assume that upload authority also permits tag edits.
Remove the unintended `latest` tags through an authenticated npm session with the required 2FA.
Keep the published alpha.1 packages and Git tags. Use alpha.2 after the release fixes are merged
and tag management is verified. Do not rerun the failed publication unchanged.

The previously published contract versions and Git tags remain as release history. New releases
publish only `kojo` and `kojo-runtime`; they do not require those old contract versions.
