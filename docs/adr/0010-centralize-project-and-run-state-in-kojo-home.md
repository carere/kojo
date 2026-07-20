# Centralize Project and Workflow Run state in Kojo Home

Kojo will register each Project from one Git repository root folder while persisting Project
identities and every Workflow Run in one installation-wide SQLite database at
`~/.kojo/state.sqlite`, with an absolute `KOJO_HOME` override. Each Project receives an opaque
UUIDv7 Project ID; its canonical path, Git metadata, and current availability may change without
changing that identity.

This replaces the worktree-local `.kojo/state.sqlite` location chosen for the earlier foreground,
repository-local CLI. The first vertical slice now includes one long-running process that schedules,
manages, and visualizes work across Projects, so one durable authority is simpler and safer than
coordinating registration, leases, lifecycle requests, and aggregate queries across many databases.

Linked Git worktrees are execution resources for Workflow Runs and Sandboxes rather than separate
Projects. A separate full clone may be registered as another Project. Branch names remain
provenance metadata; commit identity and the Workflow Revision fingerprint remain the replay
authority.

## Considered Options

- Keep one `.kojo/state.sqlite` in every registered repository folder and aggregate across them.
- Keep a central Project registry while retaining Workflow Runs in per-Project databases.
- Register every linked Git worktree as an independent Project.

## Consequences

- Kojo Home is the system of record for Project registration, Workflow Run state, and
  installation-wide operational data; repository-owned workflow behavior remains in
  `kojo.config.ts`, and secrets remain in runtime configuration sources.
- Starting a root Workflow Run requires an Enabled, Available Project, while source-independent run
  inspection and discard can operate from anywhere against Kojo Home.
- Moving or temporarily losing a repository folder does not lose Project identity or run history;
  an operator relinks the Project before compatible execution can resume.
- Archiving a Project preserves its identity and history rather than deleting durable state.
- Backup, corruption, and storage-version concerns have installation-wide impact and must be
  handled by the multi-Project storage design.
