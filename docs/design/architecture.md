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

## Authored acceptance

A Workflow chooses its checks and reviewer. Acceptance combines a mechanical Judgement and a review
Judgement. Review can be automated. A Workflow that asks a human uses an exact-Run Gate and derives
the review Judgement from that Verdict. An agent review never creates a human Verdict. This replaces
the earlier mandatory-human acceptance policy. Existing human-reviewed Workflows retain their Gates.

The issue example can accept work after checks and a separate UI agent review pass. Failed checks
or review prevent commit and integration. The author controls repair limits and delivery; the engine
does not impose issue scheduling or a mandatory human decision.

Commit and merge Phases can select an explicit branch. Omission uses the Run branch. Commit requires
the current worktree to be on that branch. Merge requires a clean worktree on its target branch and
checks Acceptance before any Git command. Branch expressions are refused. A single issue can commit
directly on its PR branch; graph integration can merge each accepted child branch into that target.
