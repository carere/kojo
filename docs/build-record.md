# Build record

Kojo started as repository-local CLI execution and moved to one per-user Daemon.

## Retained findings

- A Factory must remain authored Project source, not copied engine source.
- A Run must use an immutable Workflow Revision.
- A sandbox is a scope around phases. Suspension releases resources.
- Gate answers need durable record and apply states.
- A CLI process is not a safe owner for long-lived execution.
- Two applications must not share correctness authority through a local database file.

## Daemon cutover

The Daemon now owns Project registration, Revision capture, the correctness store, Runner
supervision, Gate application, and the Console API. CLI commands are short-lived clients.

The cutover removed:

- repository-local production databases and ownership files;
- CLI-owned Run and trigger loops;
- the terminal-owned Console server;
- client-side Gate application;
- global-package authoring compatibility exports;
- the obsolete agent invocation policy and its generated instructions.

The old entry points fail. They are not translated.

## Verification contract

The release guard checks that removed commands do not parse, removed package exports do not exist,
and forbidden compatibility text is absent. TypeScript, Biome, Knip, package checks, unit tests, and
integration tests grade the remaining graph.

The `Complete breaking release evidence` CI job is the final acceptance gate. It waits for core,
native systemd, shipped systemd, and shipped macOS jobs from one tested revision. It writes one
record for each of the 56 required check IDs under
`artifacts/verification/daemon/<tested-revision>/<check-id>/`. It refuses a cache hit, zero loaded
tests, an unnamed skip, a revision mismatch, a missing supported Host, or a missing protected-safety
regression result. The release artifact also contains one index with the complete decision.

The breaking changes and supported command surface are in
[`release-notes/daemon-cutover.md`](release-notes/daemon-cutover.md).

### Shipped macOS evidence

The `Shipped macOS release evidence` CI job runs only on a disposable macOS runner account. It
refuses to start if the account already has a Kojo installation, data path, cache path, service
definition, or loaded `dev.kojo.daemon` LaunchAgent. It does not have a mode that can run against a
developer installation.

The job packs the four publishable Kojo packages from the tested revision and installs them through
a private scoped registry. It then follows the printed install, init, doctor, registration, start,
Gate, and Console commands. The controlled Workflow makes no agent call. It publishes one real
Artifact through one real no-sandbox Resource and suspends at one real Gate.

The required artifact is named `shipped-macos-release-evidence`. Its reports are under
`artifacts/verification/daemon/<tested-revision>/RELEASE-01/`, `RELEASE-02/`, and `RELEASE-03/`.
They contain package hashes, the managed release manifest, tested revision, tool and Host versions,
loaded and skipped test counts, command logs, private-path modes, endpoint and process-group
observations, Run and Gate records, and authenticated Console screenshots. The job removes its
isolated global Kojo and Bun before it uses the managed status, repair, Gate, stop, start, and restart
commands. Cleanup removes only paths that the isolation preflight proved absent before this job
created them.
