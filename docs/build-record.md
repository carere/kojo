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
