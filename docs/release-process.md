# Release process

Use **GitHub → Actions → release → Run workflow**. Select **main** and enter the exact new version.
The workflow creates the version commit and tags, validates the package set, and publishes it.
You do not need to run local version or publication commands.

Select `dry_run` to run preparation and validation without changing remote commits, tags, or packages.
A dry run does not test registry write permissions. The next run must use the same source to validate
that version again before publication.

## Stages and evidence

| Stage | Example | Required accepted predecessor | Full Host evidence | npm tag used at publication |
| --- | --- | --- | --- | --- |
| Alpha | `0.1.0-alpha.2` | None for the first alpha | No | `alpha` |
| Beta | `0.1.0-beta.1` | Alpha or an earlier beta in the same version line | Yes | `beta` |
| Release Candidate | `0.1.0-rc.1` | Beta or an earlier RC in the same version line | Yes | `rc` |
| Stable | `0.1.0` | RC in the same version line | Yes | `latest` |

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
- npm Trusted Publisher on `kojo` and `kojo-runtime`: GitHub owner `carere`, repository `kojo`, workflow
  filename `release.yml`, with no environment restriction. Allow direct publication. Both packages
  must exist and have this setup before the workflow runs. The publication job has `id-token: write`.
- GitHub environment `npm-production`: required reviewers before stable publication.
  The `npm-prerelease` environment must not require a reviewer for unattended prereleases.

The workflow uses npm Trusted Publishing only. It exchanges GitHub OIDC for a short-lived,
package-specific npm credential through the [npm Registry API](https://api-docs.npmjs.com/),
then passes it to `bun publish`. An OIDC failure stops publication. No `NPM_TOKEN` secret or
manual npm tag commands are required.

Bun's publisher does not generate npm provenance attestations in this setup. The GitHub Release
manifest binds tested archives to their commit and workflow run. Authentication and provenance
are separate properties.

## What the workflow does

1. Prepare the coordinated version with Cocogitto in a clean checkout. This updates both public package
   versions, the lockfile, and the Runtime manifest. It creates the global `vVERSION`
   tag and two `PACKAGE@vVERSION` tags. A Git bundle gives each job the exact prepared commit.
2. Run the required checks. Pack the npm archives once. Shipped Host checks use these archives.
3. After all checks pass, obtain approval for stable publication if configured. Verify that remote
   `main` has not moved, then push the version commit and tags. Publish the checked npm archives
   directly under `alpha`, `beta`, `rc`, or `latest`, as determined by the version.
4. Create the GitHub Release with its manifest after both publications succeed.
   Full-evidence stages also attach the complete Host evidence archive.

There is no temporary npm tag or separate tag promotion. Publication makes the version available
on its channel immediately. The workflow does not delete `latest` or change other channels.
Use `@alpha` or an exact version to install an alpha; an unqualified installation uses `latest`.

After acceptance, test another system with the exact installation command in the workflow summary:

```bash
bun add -g @carere/kojo@0.1.0-alpha.2
kojo daemon install
```

On each test system, run `kojo ui`. Check Project and Workflow lists, Start and Stop actions,
Run details, Gate answers, and reconnect behavior after a Daemon restart. Record the package
version, Host, and result with each UI issue. These manual checks are separate from CI acceptance.

To install the Runtime in a Factory Project:

```bash
bun add --exact @carere/kojo-runtime@0.1.0-alpha.2
```

## Failed runs

Do not reuse a published version. If publication is partial, fix the failure and launch `release`
with a higher sequence number. A partially published version is not an accepted predecessor.
Do not delete or move published tags to make a failed version appear valid.

A failure before the remote push leaves no remote version changes. Fix the issue and launch the
workflow again. If `main` moved during validation, start a new run against current `main`.

All release validation runs before publication. No registry polling or public installation test
blocks completion after upload. Registry publication is not transactional across the two packages;
if an upload fails, inspect the failing job before choosing a new version.

The old `prerelease.yml` entry point is removed. All stages use `release.yml`.

## One-time alpha.1 cleanup

The first publication uploaded four packages, but acceptance failed. The new workflow publishes
only `kojo` and `kojo-runtime`, with the required contract source included in those archives.

Publish and validate alpha.2 before permanently unpublishing the old alpha.1 versions. Remove
`@carere/kojo@0.1.0-alpha.1` and `@carere/kojo-runtime@0.1.0-alpha.1` first, then the alpha.1 versions
of `@carere/kojo-client-contracts` and `@carere/kojo-runner-contracts`. This is a separate registry
administration task with interactive authentication, subject to npm's unpublish rules. It is not
part of the release workflow. Do not delete `latest` as a prerequisite for alpha.2 publication.

Keep Git tags as source history. Published version numbers cannot be reused, even after unpublication.
