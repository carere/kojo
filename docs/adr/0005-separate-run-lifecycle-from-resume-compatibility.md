# Separate Workflow Run lifecycle from Resume Compatibility

Kojo will persist one Workflow Run State—Running, Suspended, Interrupted, Failed, Completed, or
Discarded—and diagnose Resume Compatibility separately. Resumption preserves the Workflow Run's
identity and evidence, starts a new Execution Attempt, and requires an exact match of the pinned
Workflow Revision's stable name, declared version, and replay-relevant source fingerprint.

The first local CLI stores UUIDv7-identified Workflow Runs in `.kojo/state.sqlite` at the Git
worktree root. The store is local and ignored, initialized lazily, protected with owner-only
permissions, and intentionally not shared across linked worktrees. Run inspection and discard open
this store without requiring currently valid workflow source; starting and resuming still require a
valid Workflow Registry, and resuming additionally requires exact Resume Compatibility.

The worktree-local storage-location part of this decision is superseded by
[Centralize Project and Workflow Run state in Kojo Home](./0010-centralize-project-and-run-state-in-kojo-home.md).
The separation of Workflow Run State from Resume Compatibility remains accepted.

This separation keeps operational history truthful: restoring or changing available source cannot
rewrite whether a run failed or was interrupted. Exact revision matching also prevents completed
Activity results from being replayed through changed control flow.

## Considered Options

- Persist Incompatible as another Workflow Run State.
- Resume against whichever repository-local workflow is currently discovered.
- Infer compatibility from the author-declared version alone.
- Store and silently execute a private snapshot of old workflow code.
- Create a new Workflow Run whenever unfinished work resumes.

## Consequences

- The CLI and visualizer report Workflow Run State and Resume Compatibility as separate facts.
- Kojo fingerprints the complete replay-relevant executable closure and records the fingerprint
  algorithm, source provenance, and workflow ABI.
- There is no forced resume or migration in the first vertical slice; the engineer restores the
  exact Workflow Revision or discards the run.
- Every resume creates a numbered Execution Attempt while retaining all earlier attempts and
  uncertain at-least-once Activity evidence.
- A dirty Workflow Revision may be started, but Kojo warns that it may become impossible to restore.
