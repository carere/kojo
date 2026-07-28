---
status: accepted
---

# Assess and repair Project Runtime readiness by capability

Kojo represents Project Runtime Readiness as a structured, resource-scoped assessment rather than one health flag. This lets safe existing work continue while new or damaged work is blocked, without allowing repair to overwrite developer source or silently replace durable execution history.

## Decision

### Condition and capabilities

- Every assessment has an overall condition of `ready`, `limited`, or `needs-attention`.
- `ready` means every required capability is available. `limited` means Kojo can safely inspect, control, or progress some existing work while at least one recovery, manual-start, or schedule capability is blocked. `needs-attention` prevents execution progress while retaining project-level inspection and repair.
- Explicit capability results are authoritative. They separately cover project inspection, history inspection, control of existing runs, recovery, manual starts, schedule processing, and safe repair.
- A finding blocks the smallest resource scope proven safe. Project layout, identity, store, ownership, migration, and cold configuration failures block project-wide execution. A missing Workflow Definition, missing sandbox, or missing run engine state blocks only its dependent resources when the rest of the Project is proven sound.
- A parent waiting on a blocked Child Workflow Run is blocked through their existing ownership relationship.
- Kojo collects every finding it can establish safely in one assessment. A check that cannot proceed records the prerequisite that prevented it rather than guessing.

### Findings and reassessment

- Each active Readiness Finding exposes a stable key and code, affected resource identity or path, blocked capabilities and dependents, a safe summary, relevant current and required identities or versions, repair class, typed repair actions, and first- and last-observed times.
- Every assessment exposes Project Identity, canonical path, assessment revision and time, overall condition, capability summaries, active findings, and repairs completed during that assessment.
- Successful lossless repairs are reported as repaired notices and do not remain active findings. A failed automatic repair becomes an ordinary active finding.
- Kojo reassesses after an explicit refresh or repair, Host activation, and observed relevant project-file changes. An operation blocked by an old assessment requests a fresh assessment. A finding clears only after its complete affected check succeeds.
- When an enabled schedule becomes available again, it follows its existing rule of selecting the next strictly future occurrence rather than catching up the unavailable interval.

### Configuration and Workflow Definitions

- Configuration loading distinguishes a missing or incompatible `@kojo/workflow` dependency, missing configuration, module-load failure, invalid configuration value, duplicate Workflow Key, invalid schema, duplicate Schedule Key, invalid schedule, and missing child definition.
- A configuration snapshot remains atomic. If a live Project Runtime cannot load a replacement, it retains its last accepted executable snapshot for compatible existing work but blocks all new manual and scheduled starts. It does not partly apply the invalid replacement.
- After Host restart, stored metadata cannot recreate executable source. Current Kojo Configuration must load before recovery or new work can progress.
- A live runtime may retain an already-loaded older Workflow Definition Revision for existing runs while new starts use the current valid revision. After restart, a non-final run whose revision is unavailable remains blocked. V1 has no historical executable-definition registry.
- Reusing a Workflow Definition Revision with conflicting schema or source identity blocks that Workflow Definition's starts, schedules, and affected recovery. Kojo does not infer compatibility from an unchanged revision string.
- Removing a definition is not a readiness problem when no non-final run or enabled schedule depends on it. A non-final run produces a run-scoped finding. An enabled schedule retains enabled intent, becomes unavailable, and makes the Project limited; a removed disabled schedule does not reduce Project Runtime Readiness.
- Repair restores compatible tracked source or dependencies. Kojo never edits workflow source, changes a revision, fails a run, or creates a replacement run automatically. An explicit stop remains available, but a run stays `stopping` when unavailable code prevents required cleanup.

### Project layout and identity

- Kojo automatically updates the Project Index after a known working tree moves, tightens permissions on Kojo-owned paths when ownership and file kind are safe, recreates `artifacts/`, and recreates an empty `sandboxes/` only when durable records prove no non-final run needs its contents.
- A missing root `/.kojo/` ignore rule blocks recovery and new work but leaves inspection and safe control available. An explicit initializer or repair action may append the rule without rewriting existing `.gitignore` content.
- A symbolic link, wrong file kind, wrong owner, unrepairable permissions, unsupported layout version, invalid metadata, or conflicting Kojo-owned path blocks project-wide execution and is never replaced silently.
- Duplicate Project Identity at two paths prevents either copy from acquiring engine ownership. Kojo reports both paths and requires `kojo init --new-identity` on the copy.
- Missing `project.json` or `kojo.sqlite` in a known Project is possible data loss. Only the explicit `--replace-missing-data` action creates fresh state, preserving the known Project Identity and warning that prior execution history cannot be recovered.

### Store, migration, and engine damage

- Compatible database migrations run automatically under exclusive ownership with the required backup and transaction. Kojo verifies and restores the original database after an interrupted or failed migration before retrying.
- Kojo attempts a given migration once per Host activation. A failure leaves the restored database in place, blocks execution, and requires an explicit retry after correction.
- Kojo never downgrades an unknown newer database or guesses an incompatible migration. The finding names the required Kojo version or backup.
- Failure to acquire engine ownership permits safe read-only inspection but blocks recovery and new work. Kojo retries transient failures with bounded delay and never steals ownership unless the backend proves its lease expired.
- Database corruption, missing engine-wide data, or an Effect execution without its required Kojo record blocks the entire Project Runtime. One acknowledged Workflow Run whose Effect execution disappeared blocks that run and dependent parents if database integrity is otherwise proven.
- Missing sandbox state blocks dependent non-final runs. Missing Execution Artifact content reduces historical detail but does not affect readiness or recorded outcomes.
- Kojo never reconstructs authoritative state from diagnostic logs, Execution Events, or Execution Artifacts.

### Stable finding codes

Successful automatic work uses these repaired-notice codes:

- `project.path-updated`
- `layout.permissions-tightened`
- `layout.artifacts-recreated`
- `layout.empty-sandboxes-recreated`
- `layout.version-upgraded`
- `store.migrated`

Resource-scoped active findings use these codes:

- `layout.ignore-rule-missing`
- `workflow.revision-unavailable`
- `workflow.revision-conflict`
- `schedule.definition-unavailable`
- `run.engine-state-missing`
- `sandbox.state-missing`

Configuration loading uses these distinct codes. They produce `limited` with a usable live snapshot and `needs-attention` after cold activation:

- `dependency.workflow-package-missing`
- `dependency.workflow-package-incompatible`
- `configuration.missing`
- `configuration.load-failed`
- `configuration.invalid`
- `workflow.key-duplicate`
- `workflow.schema-invalid`
- `workflow.child-definition-missing`
- `schedule.key-duplicate`
- `schedule.definition-invalid`

Project-wide active findings use these codes:

- `layout.path-conflict`
- `layout.symbolic-link`
- `layout.owner-invalid`
- `layout.permissions-invalid`
- `layout.version-unsupported`
- `layout.metadata-invalid`
- `project.identity-missing`
- `project.identity-duplicate`
- `store.missing`
- `store.open-failed`
- `store.integrity-failed`
- `store.version-unsupported`
- `store.migration-failed`
- `engine.ownership-unavailable`
- `engine.global-state-invalid`
- `engine.execution-unowned`

### Repair protocol

- The control contract exposes typed `layout.add-ignore-rule`, `project.assign-new-identity`, `project.replace-missing-data`, `store.retry-migration`, and `readiness.refresh` actions.
- A client submits the action key, target, and assessment revision it observed. The Host rechecks every precondition before changing state and rejects stale or unsafe requests.
- Installing dependencies, restoring source or a database, and correcting path ownership remain developer actions described by findings. Displayed package-manager commands are guidance, not remotely executable repair instructions.
- A blocked operation returns a structured not-ready result with the current assessment revision and responsible finding keys. User-visible details are sanitized and carry a diagnostic reference rather than secrets or unrestricted raw exceptions.

## Considered Options

- One pass/fail readiness flag was simpler but could not distinguish safe inspection and control from unsafe recovery or new work.
- Blocking the whole Project for every missing definition was conservative but would unnecessarily stop unrelated workflows whose storage and executable definitions are sound.
- Persisting executable historical definitions would improve recovery across source changes but would add a deployment archive and compatibility surface beyond v1.
- Automatically installing dependencies, editing configuration, replacing data, or stealing engine ownership would make repair convenient at the cost of modifying developer work or hiding data loss.
- Fail-fast validation would shorten checks but force developers through repeated repair cycles and make the control clients unable to present a complete actionable assessment.

## Consequences

- Project Runtime and control interfaces need capability-aware readiness results rather than a shared boolean.
- Unit tests can exercise every finding and repair through in-memory project layout, definition loader, store, and workflow backend services. Integration tests must cover real paths, permissions, SQLite migrations, ownership, and restart behavior.
- CLI and visualizer decisions can choose presentation and interaction patterns without redefining readiness semantics or repair safety.
- Distribution policy must ensure the Host can identify compatible Kojo and `@kojo/workflow` versions, but exact installation and upgrade mechanics remain outside this decision.

This decision resolves [Define Project Runtime readiness and repair semantics](https://github.com/carere/kojo/issues/18) and follows [Define the initialized Kojo Project layout](https://github.com/carere/kojo/issues/8), [Use one project database with separate execution authorities](./0006-use-one-project-database-with-separated-execution-authorities.md), and [Host Project Runtimes in one supervised local service](./0004-host-project-runtimes-in-one-local-service.md).
