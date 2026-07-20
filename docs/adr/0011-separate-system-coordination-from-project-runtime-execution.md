# Separate system coordination from project-local execution

Kojo will run one long-running Kojo System Process per Kojo Home as the installation-wide
coordinator while executing repository-local Developer Workflow code in transient Project Runtime
Processes. Each Project Runtime Process uses the matching project-local Kojo CLI, exact compatible
Effect and Bun stack, and a fixed source materialization for one root Workflow Run Tree's active
Execution Attempts. This boundary lets one process coordinate Projects, schedules, and local
interfaces without loading mutable or incompatible Project code into its own runtime.

The Kojo CLI Launcher is short-lived. System operations go to the Kojo System Process, while
operations that load Project code delegate to the matching project-local CLI. The System Process
and every Enabled Project must use the same Kojo version in the first vertical slice; a mismatch
makes the Project Unavailable for new starts and resumption without removing source-independent
inspection or discard.

For normal and scheduled starts, Kojo selects and validates a Project Source Revision: a recorded
default-branch commit plus its Workflow Registry, provenance, freshness, and compatible toolchain
evidence. Kojo keeps a bare Git mirror only as an internal cache and materializes a temporary clean
Runtime Source Checkout for each Project Runtime Process. An explicit direct `--from-checkout`
start instead freezes the reachable clean, dirty, and untracked source into a temporary Checkout
Source Snapshot. Runtime source is immutable; mutable repository work remains inside
workflow-authored Reusable Sandboxes.

One of two installation-local Project Source Policies selects a new Project Source Revision.
`LocalWithFreshnessWarning` executes the registered repository's local default branch while
diagnosing remote freshness; `RemoteLatest` requires a successful fetch of the remote default
branch. A candidate revision becomes active only after complete validation. An invalid candidate
makes the Project Unavailable for new root starts rather than silently retaining an older active
definition, while existing Workflow Runs remain pinned to their own Workflow Revisions.

## Considered Options

- Load every Project's Workflow Registry and Developer Workflows directly into the Kojo System
  Process.
- Keep one long-lived runtime process per Project and multiplex unrelated root Workflow Run Trees
  through it.
- Execute scheduled work from the developer's current checkout or switch that checkout to the
  default branch.
- Give every Workflow Run exactly one mutable worktree instead of preserving workflow-authored
  Reusable Sandbox boundaries.
- Require remote source for every Project or fetch remotes without an explicit source policy.
- Support multiple Kojo versions concurrently through a cross-version worker protocol in the first
  vertical slice.

## Consequences

- `kojo start` owns a single background process per Kojo Home, with foreground, status, logs,
  graceful stop, and coordinated restart interfaces. It does not install an operating-system login
  service in the first slice.
- A Project Runtime Process never continues independently after losing the System Process. It
  starts no new Activity, attempts to settle the current Activity, then exits; an uncommitted
  outcome remains uncertain and recovery marks the affected Workflow Runs Interrupted.
- Project source activation reloads the Workflow Registry without restarting Kojo. Running
  Workflow Runs and their Project Runtime Processes remain pinned to their existing revisions.
- Runtime Source Checkouts and Checkout Source Snapshots are temporary and do not strengthen
  Kojo's promise to retain executable source for future resumption.
- Local Sandcastle providers give each Reusable Sandbox its own branch and worktree; one Workflow
  Run may use zero, one, or many such worktrees independently from its Runtime Source Checkout.
- Native macOS and Linux hosts are in scope. Native Windows process integration is deferred.
- Database writer, transaction, lease, and project-local coordination details remain with the
  multi-Project storage decision; cron trigger and overlap behavior remain with the scheduling
  decision.
