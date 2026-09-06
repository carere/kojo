# Alpha cleanup audit — 2026-09-06

The audit covered the CLI and Daemon, Runtime, both contract packages, Console, Factory,
GitHub scripts and workflows, root tooling, and docs. Three subagents reviewed separate areas.
The main review traced callers and checked their findings against the active implementation.

A normal `bun knip` passed before cleanup. That result did not prove that all code was useful:
tests kept obsolete implementations reachable. A separate production reachability check, with
the Factory and managed launcher included as entry points, exposed these test-only paths.
Every removal below was checked against runtime callers, package exports, fixtures, and docs.
Dynamic Runner fixtures, generated templates, public APIs, and native Host entry points need
manual checks; production Knip output alone is not a deletion list.

## Removed or moved

| Area | Change | Evidence |
| --- | --- | --- |
| CLI scaffolding | Remove `ImageBuilder`, Docker and in-memory adapters, and obsolete builder integration tests. Remove the always-empty `Initialised.image` and unreachable CLI success branch. | `initialise` only stamps files. No production code called the builder. Dockerfile and image-name generation remain. |
| Runtime Gate | Remove `GateRepository`, `AskedGate`, `GateStoreError`, no-op Runner layer, old model tests, and npm/JSR exports. | The Daemon owns durable Askings and Deadlines. The removed model allowed late answers through an obsolete `overdue` state. |
| Project registration | Remove the old Effect `ProjectRepository`, in-memory adapter, `registerProject`, and unused SQLite layer. | `ProjectApi` uses `DaemonProjectRepository` and the active SQLite implementation directly. Its registration tests remain. |
| Project recovery | Remove `runnerFaultLocality` and its helper-only assertion. | No production caller. Runner channel integration tests still check connection fault handling. |
| Shared CLI code | Remove duplicate decode, decode-issue, Run ID, and Sandbox ID modules. Move three test files to Runtime. | Only tests imported the CLI copies. Runtime owns the active implementations; their tests now exercise that code. |
| Client contracts | Remove generic observation and wire-pagination modules, exports, and fixture rows. | Current endpoints return typed Project, Gate, and Run snapshots. Console pagination uses local offsets. |
| Release commands | Remove `verify-predecessor`, `verify-active-tags`, their helper, and unused metadata field. | No callers. Current preparation verifies accepted GitHub Releases and public package bytes. Mutable tags do not prove acceptance. |
| CI | Remove unused normal-CI evidence log copies. | No later step consumed or uploaded them. Release evidence collection remains. |
| Test support | Remove unused live-Agent fixture options and an old repository-local database ignore entry. Move synthetic external-action identity generation into test support. | These were unused options or fixture-only code, not current execution logic. |

The Runtime Gate and client-contract removals change deep-import APIs. They are deliberate
pre-alpha removals. Generated Factories and this repository's Factory do not use those APIs.

## Corrected

- The Factory unit command now runs all four package unit tasks through Moon. Its type check
  also checks the standalone Factory config; the old comment cited a test that no longer exists.
- Factory permissions and Agent prompts protect the actual `.agents/skills/kojo/` path and the
  generated `.claude/skills/kojo/` path. The ship comment names the GitHub release workflow.
- The public-type guard now depends on Runtime compilation, whose declarations it reads.
- `.github/biome.json` adds script checks; those TypeScript files were previously excluded.
- Console comments, package description, domain references, configuration wording, Trigger
  acknowledgement comments, and stale CLI container-test comments now match current behavior.
- Release cutover tests now read the skill from `.agents/skills/kojo/`, rather than its old path.
- Knip comments now describe explicit package exports. Its Runner fixture exception remains:
  fresh-process tests load those hidden `.kojo` files by path.

## Why the GitHub scripts remain

All 17 scripts have active callers. Alpha skips some native Host checks; beta, Release Candidate,
and stable releases still require them. Removing them would remove release evidence.

| Script | Caller and purpose |
| --- | --- |
| `check-contract-codecs.ts` | CI and Release checks; checks generated codecs. |
| `generate-contract-codecs.ts` | Codec check and author command; generates independent package copies. |
| `cocogitto-package-version.ts` | `cog.toml`; updates coordinated package versions. |
| `prepare-release.ts` | Release workflow; selects the predecessor and prepares the version commit. |
| `verify-accepted-prerelease.sh` | Release preparation; verifies accepted predecessor bytes. |
| `release-train.ts` | Release workflow and preparation; packs, checks, installs, and publishes npm packages. |
| `release-jsr.ts` | Release workflow and preparation; stages, checks, installs, and publishes JSR packages. |
| `release-tags.ts` | Release workflow; protects and promotes npm tags. |
| `complete-release-evidence.ts` | Release checks and acceptance; collects and verifies evidence. |
| `systemd-native-evidence.sh` | Release checks; tests native Host lifecycle. |
| `systemd-shipped-evidence.sh` | Release checks; tests shipped packages on systemd. |
| `systemd-shipped-user-evidence.sh` | Shipped controller; runs installed CLI flows. |
| `systemd-shipped-login-readiness.sh` | Native and shipped controllers; waits for user-manager readiness. |
| `systemd-shipped-login-state-evidence.sh` | Controllers and helpers; records sessions and linger state. |
| `systemd-shipped-logout-readiness.sh` | Native and shipped controllers; checks logout and manager shutdown. |
| `systemd-shipped-linger-authorization.sh` | Shipped controller; checks linger authorization. |
| `systemd-shipped-singleton-evidence.sh` | Shipped user helper; checks duplicate Daemon rejection. |

The two generated JSON codec copies also remain. Their contract packages must stay independent.
Historical ADR, research, build, and test-audit records remain as decision history. They must not
be read as current operator instructions.

## Follow-up work

1. **Replace helper-only release evidence.** `runnerIdle.ts` and `retryCycle.ts` have no production
   callers. Their tests are still cited by `CompleteReleaseEvidence.ts` for `SCHED-03` and
   `STATE-04`. Actual idle termination is in `ProjectRunnerTransport.ts`; actual Trigger retry is
   in Runtime `runner/main.ts`. Add tests through those live paths, then remove the two helpers
   and update the evidence map. Existing helper tests do not prove the live behavior.
2. **Check Run provenance.** Runtime `BuildInfo` remains active in Run tracing, but defaults its
   configuration digest to `unconfigured`. The Runner does not supply that reference. Check the
   intended relationship with the captured Workflow Revision before changing or removing it.
3. **Add static TypeScript coverage for GitHub scripts.** Biome now checks them, but the root
   TypeScript build still has no project reference for `.github/scripts`. Script integration
   tests do not replace a type check.

This audit proves the listed removals and records known gaps. It is not release acceptance.
Native Host evidence and registry publication still belong to the release process.

## Validation

- CLI unit suite: 365 tests passed.
- Runtime: 256 unit tests and 96 integration tests passed, including the moved shared tests.
- Contracts: 11 client tests and 18 Runner tests passed.
- Full CLI integration run: 230 passed; two failed on old skill paths. After correcting the
  paths, all 13 tests in the affected cutover suite passed. Other integration files passed in
  the full run; the full suite was not repeated after the path-only fix.
- Root TypeScript build, standalone Factory type check, Knip, Biome, package graph, public-type
  guard, generated codec check, Bash parsing, and workflow YAML parsing passed.
- Console changes are comments and metadata only. Existing browser tests were not rerun.
- Native Host suites and registry publication were not run.

One intermediate repository scan overlapped integration fixtures and reported their temporary
package copies. The final Knip and Biome checks ran after fixture cleanup.
