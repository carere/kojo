# Release process

Kojo uses one coordinated Release train for these public packages:

- `@carere/kojo-client-contracts`
- `@carere/kojo-runner-contracts`
- `@carere/kojo-runtime`
- `@carere/kojo`

All four packages and `packages/kojo-runtime/runtime-manifest.json` use the same version. Published
versions are immutable. Publish the packages in the order above so the CLI is last.

## Release ownership

Cocogitto owns the coordinated version change. It updates the four package manifests, the runtime
manifest, and the lockfile. It also writes the root and package changelogs, makes the
`chore(version)` commit, and makes one Release tag plus four package tags.

The GitHub workflows own package creation, publication, public Host validation, and promotion. Do
not publish packages from a Cocogitto hook. Cocogitto does not undo a bump when a later hook fails,
so publication must stay in the workflows where a failed candidate cannot change `latest`.

## Release stages

One Release line moves through these stages:

| Stage | Version example | Change policy | Exit gate |
| --- | --- | --- | --- |
| Alpha | `0.1.0-alpha.1` | Features, refactors, and breaking changes can continue. | Exact-revision CI evidence and clean public installs pass on Linux and macOS. |
| Beta | `0.1.0-beta.1` | Feature freeze. Fix behavior, packaging, and Project usability. | Supported-Host evidence and representative Project trials pass. |
| Release Candidate | `0.1.0-rc.1` | Code freeze. Only Release blockers can change. | The exact public package set passes all evidence and Project trials. |
| Stable | `0.1.0` | Only version files and Release notes can differ from the accepted RC. | The public stable candidate passes Linux and macOS validation, then a human approves promotion. |

A failed candidate does not move to the next stage. Fix the problem and publish the next sequence,
such as `0.1.0-beta.2`. Do not reuse a published version.

Sequence numbers identify immutable publish attempts and can have gaps. The `previous_candidate`
input is the last accepted candidate: beta requires an accepted alpha or beta, and RC requires an
accepted beta or RC. Alpha starts a Release line, so it has no required predecessor.

## Registry tags

- `alpha`, `beta`, and `rc` point to the active candidate in that stage.
- `next` points to the active prerelease, then to the stable Release after promotion.
- `candidate` hides a package set while its public bytes are validated.
- `latest` points only to the promoted stable Release.

The first publish of a new package can receive `latest` even when it uses another tag. The
prerelease workflow removes `latest` only when it points to the prerelease that the workflow just
published. It does not change an existing stable `latest` tag.

## Candidate manifest

Every candidate has `release-manifest.json`. It records the Release stage, version, tested Git
revision, workflow run, package order, archive names, sizes, SHA-256 hashes, and registry integrity
values. Public validation refuses a package when the registry integrity is different from the
tested archive.

An accepted prerelease is a GitHub prerelease named `v<version>` with this manifest as an asset.
The stable workflow accepts only an RC manifest from the same Release line.

## Prerelease runbook

1. Start from a clean, current `main` branch. Run
   `cog bump --version <version> --include-packages` with the next exact prerelease version.
2. Inspect the generated version files, changelogs, `chore(version)` commit, and five tags. Push the
   commit and all five tags in one atomic push. Cocogitto tags are lightweight, so do not use
   `--follow-tags`.
3. Wait for the complete CI evidence for the exact tagged revision.
4. Run **Actions → prerelease** first as a dry run. In the workflow ref selector, select the
   `v<version>` tag. Give it the accepted previous candidate. Leave that input empty for an alpha.
5. Run it again with the same stage, version, and predecessor, with dry run disabled.
6. Confirm that the workflow creates the GitHub prerelease. This means both supported Hosts
   installed the exact public package set.
7. Exercise the accepted candidate in representative Projects. Record any blocker before the next
   stage.

The workflow publishes dependencies before the CLI. If publishing stops after only part of the
package set is public, abandon that version and use the next sequence. A partial package set is not
a candidate.

## Stable runbook

1. Select the accepted RC that will become stable.
2. From a clean, current `main` branch, run
   `cog bump --version <stable-version> --include-packages`. Inspect the generated version files,
   changelogs, commit, and tags. The stable bump can add Release notes, but it must not change code.
3. Push the commit and all five lightweight tags in one atomic push. Wait for complete CI evidence
   for the exact tagged revision.
4. Run **Actions → release** first as a dry run. In the workflow ref selector, select the stable
   `v<version>` tag. Enter both the stable version and accepted RC.
5. Run it again with dry run disabled. The workflow publishes under `candidate`, then validates the
   exact public bytes and clean installs on Linux and macOS.
6. Review the validation result at the `npm-production` environment gate. Approve only when the
   candidate manifest and both Host jobs are correct.
7. Promotion moves `latest` and `next`, removes temporary tags, and creates the stable GitHub
   Release. It does not republish packages.

Configure the `npm-production` GitHub environment with required reviewers before the first stable
Release. Store the npm publish token as the `NPM_TOKEN` repository secret. The token must be able to
publish all four packages and change their distribution tags.

## Recovery

Do not promote when validation fails. The stable version is already immutable after it is
published under `candidate`. Diagnose the failure, create a new patch Release line and RC, and run
the stable process again. Keep `latest` on the last accepted stable Release.

## First Release train

The next action is the first Cocogitto bump from a clean, current `main` branch:

```sh
cog bump --version 0.1.0-alpha.1 --include-packages
git push --atomic origin main \
  v0.1.0-alpha.1 \
  kojo-client-contracts@v0.1.0-alpha.1 \
  kojo-runner-contracts@v0.1.0-alpha.1 \
  kojo-runtime@v0.1.0-alpha.1 \
  kojo@v0.1.0-alpha.1
```

Inspect the generated commit and tags before the push. After the push, wait for complete CI
evidence. Then run the `prerelease` workflow as a dry run with stage `alpha`, version
`0.1.0-alpha.1`, and no previous candidate. Select `v0.1.0-alpha.1` in the workflow ref selector.
