# Kojo architecture

## Domain model

A **Factory** is authored source in a Project. It contains Workflows, commands, prompts, schemas,
and checks. A **Workflow Revision** is an immutable Daemon capture of that source and its resolved
packages. A **Run** executes one Revision. A **Gate** suspends a Run until an actor answers.

One per-user **Daemon** is the control plane. It owns:

- the correctness store;
- Project registration and Factory refresh;
- Workflow Revision capture;
- Runner processes and Run recovery;
- Gate answer recording and application;
- the HTTP API and Console.

The CLI and Console are clients. They do not open the store and do not execute a Workflow.

## Package boundaries

`@carere/kojo-runtime` is the Factory authoring runtime. It contains the Workflow DSL, phase
services, ports, models, and adapters that a captured Revision needs.

`@carere/kojo` contains the CLI, scaffolder, lifecycle manager, Daemon, and Project integration.
It does not export authoring compatibility paths.

## Execution

A client starts a Workflow with a Project id, Workflow name, and JSON payload. The Daemon resolves
the available Revision, creates a Run, and assigns it to its Runner. The Runner is the only
application that executes the Workflow.

A sandbox is a scope around phases. A suspension releases the scope. Resume acquires a new scope
and replays recorded phase results. A Run branch and captured Revision provide durable identity.

## Storage

The Daemon uses one per-user data root. Project repositories contain authored Factory source only.
They do not contain production Run databases, ownership files, or answer queues.

## Compatibility rule

Removed commands, imports, and runtime helpers fail at their boundary. Kojo does not translate them
to the new model because translation would keep two authorities alive.
