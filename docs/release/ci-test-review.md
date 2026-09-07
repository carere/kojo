# CI and test review — 2026-09-07

## Failure examined

[CI run 34066439236](https://github.com/carere/kojo/actions/runs/34066439236) failed one assertion
in `packages/kojo/tests/integration/release/contractCutover.test.ts`. It required the literal
`verify-complete` in `release.yml` after that post-publication step was intentionally removed.
Core checks and seven integration shards passed. The final `Test` job reported the shard failure.
This was a stale test requirement, not a product failure or timeout.

The assertion was reproduced locally and removed. Package entry-point checks remain.
Release ordering is checked in `tests/repository/scripts/releaseTrain.test.ts`.

## Implemented cleanup

- Shared core commands in `.github/actions/core-checks/action.yml`; both CI and Release checks call it.
- Core and integration jobs run concurrently during release. `core-evidence` joins their logs afterward.
- Renamed the reusable integration workflow to `integration.yml` to reflect adapter and process coverage.
- Moved seven repository and release-tooling files to `tests/repository`, with a separate Vitest project
  and Moon task. Process-test inputs no longer include workflows, GitHub scripts, or documentation.
- Removed workflow string slicing, exact command formatting, and guidance phrase assertions from
  cutover/release tests. Retained package checks and a small parsed dependency check. The required
  result script is executed against success, failure, cancellation, and skip results.
- Updated full Host evidence to consume the moved repository results. Project registration evidence
  now uses the current real-adapter tests; removed its reference to a deleted unit test.
- The required `Test` job prints each upstream result before reporting failure.
- Resource and CLI process fixtures use the OS temporary directory. Integration CI mounts a
  private 2 GiB memory-backed temporary filesystem. One measured Resource capture writes more
  than 3,000 package files and calls file sync 6,426 times; repeating it on runner disk made
  30-second cases time out. This fixture storage still exercises real filesystem, SQLite, and
  process adapters. Native Host release checks retain disk storage.

The findings below describe the starting state. Release stage policies and native Host coverage
remain unchanged. No timeout increase or extra shards were added; the integration distribution
changes naturally when repository tests leave that suite.

## Workflow responsibilities

| File or job | Responsibility | Assessment |
| --- | --- | --- |
| `ci.yml` | Run core checks and integration shards on PRs and main | Keep |
| `ci.yml`: `required`, displayed as `Test` | Combine core and integration results for branch protection; run no tests | Keep; its output should identify the failed upstream group |
| `cli-integration.yml` (now `integration.yml`) | Run Kojo integration tests in eight parallel jobs | Keep parallel execution; the old name hid adapter and repository coverage |
| `release-checks.yml` | Check the prepared version, pack archives, and run full Host evidence for beta, RC, and stable | Share core commands with CI; it is not a post-publication gate |
| `release.yml` | Prepare version, call checks, publish, create GitHub Release | Keep publication after checks, without public-registry polling afterward |

## Test inventory

Counts are test files, not individual test cases, at revision `f8fce8d`.

| Package | Unit | Integration | Native Host | Shipped macOS |
| --- | ---: | ---: | ---: | ---: |
| Kojo | 61 | 53 | 1 | 1 |
| Runtime | 34 | 14 | 0 | 0 |
| Client contracts | 2 | 0 | 0 | 0 |
| Runner contracts | 2 | 0 | 0 | 0 |

Normal CI runs the unit and integration projects. Native Host and shipped-installation evidence
are separate release checks. Alpha skips those full Host jobs. No browser suite runs in CI.

## Findings and recommended changes

1. **Workflow-text tests constrain implementation details.** `contractCutover.test.ts` parses
   YAML with string slicing and asserts exact step names, shell text, and counts of piped blocks.
   `releaseTrain.test.ts` also checks documentation phrases and script source. These checks can
   reject a valid refactor without exercising the behavior they claim to protect. Keep a small set
   of parsed workflow checks for test-before-publish ordering and required dependencies. Use actual
   script execution for script behavior. Remove prose and incidental formatting assertions as those
   tests are revised. Do not replace the obsolete assertion with another requirement for the old step.

2. **Core CI commands are duplicated.** `ci.yml` and `release-checks.yml` each list TypeScript,
   Biome, Knip, codec synchronization, contract tests, Runtime tests, Kojo unit tests, package graph,
   public types, and Console build. Changes must be maintained twice. Extract shared execution,
   while keeping release archive preparation and evidence collection separate.

3. **Release core checks start unnecessarily late.** The `ci` job in `release-checks.yml` needs
   `cli-integration` because it later collects shard logs. Core tests themselves do not need those
   logs. Run core and integration jobs concurrently and join only for evidence collection and
   publication. The release should still require both groups to pass.

4. **Integration shard work is uneven.** In the examined run, core checks took 41 seconds and
   integration jobs took 37–141 seconds, including setup. Review the slowest files before increasing
   timeouts or the number of shards. A static workflow assertion caused this failure; changing process
   deadlines would not fix it. This single run is not enough to attribute the duration spread solely
   to test distribution, because cache hits and runner setup also affect it.

5. **Broad inputs reduce cache reuse.** `kojo:test-integration` includes every workflow, GitHub script,
   multiple documentation trees, and all Kojo source. A release-doc edit can invalidate expensive
   process tests. Separate repository-configuration checks from adapter and CLI integration tests,
   then give each Moon task its actual inputs. Keep shared fixtures in all tasks that use them.

6. **Some release rules are policy, not product tests.** The accepted alpha → beta → RC → stable
   sequence, stable source restrictions, and named Host evidence are extra release policies. They
   currently apply even when core tests pass. They should be reviewed explicitly for the maintainer's
   desired release process; they are not needed to explain or fix today's failure. They were not
   removed in this review.

Keep behavioral coverage for package staging, OIDC publication arguments, contract encoding,
SQLite persistence, process lifecycle, Workflow execution, Gate handling, and package importability.
Reading files in a test is not itself a defect: packed-file and generated-output checks test shipped
behavior. The problem is asserting incidental source text instead of the required result.

## Scope

This review inspected workflow execution, Moon/Vitest configuration, release and cutover tests,
package guards, and the failed run. It inventoried the test files; it did not assess every individual
domain assertion or prove that every integration suite is free from timing issues.
