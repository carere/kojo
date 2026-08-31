# Context Map

Kojo uses the multi-context layout. The context slugs name the bounded contexts of
`src/contexts/<bounded-context>/`. This map includes the accepted Daemon design; the existing code
and [earlier package layout](../design/typescript-effect.md) do not yet implement all these boundaries.

## Contexts

- [**daemon**](./daemon.md): the per-user service, managed releases, lifecycle operations, and
  durable client operation receipts
- [**project**](./project.md): the Project catalogue and location lifecycle, Project Runner
  supervision, Resource leases, and Project recovery
- [**workflow**](./workflow.md): the Factory, Workflow Revisions and their retention, Phase
  contracts, Run admission and scheduling, Run Claims, correctness state, wake-ups, Run recovery,
  and cancellation
- **agent**: who the agents are, and one agent call — not yet written
- **sandbox**: the isolation boundary and the working copy — not yet written
- [**gate**](./gate.md): Askings, Verdicts, Deadlines, and Recorded and Applied states
- [**trigger**](./trigger.md): what requests automatic Runs, and how a user controls those requests
- [**trace**](./trace.md): observability records and their read models, plus Artifact metadata,
  content access, and retention separate from Trace-record retention

Until a context file exists, the vocabulary table in
[docs/design/architecture.md §6](../design/architecture.md) is authoritative for that context.

`shared` is a code bucket for elements used by several contexts. It is not a bounded context, so
it has no context file and no ADR directory.

For the accepted package and transaction boundaries, see
[Domain ownership survives Daemon replacement](../adr/root/0001-daemon-context-and-package-boundaries.md).

## Relationships

- **daemon -> project and workflow**: lifecycle operations coordinate Daemon drain and replacement.
  The Daemon retains state ownership and Project Runner supervision; the lifecycle controller
  does not acquire either authority while the endpoint is absent.
- **daemon -> domain operations**: durable client operation receipts retain accepted outcomes.
  The context that owns an operation retains its domain rules; receipt ownership does not move
  those rules into daemon.
- **project -> workflow**: a Project locates the repository whose Factory declares the Workflows
  that Kojo can discover and run. Project ID plus Workflow name identifies one Project Workflow.
- **project -> workflow execution**: the Daemon supplies a Project Runner on demand for one Project;
  an idle Project need not have a live Project Runner. A Project Runner instance can hold a fenced
  Run Claim, but the Daemon remains the state owner. Project recovery establishes resource safety;
  Run recovery establishes whether an interrupted Run can continue.
- **trigger -> workflow**: a Trigger supplies Run requests for one Project Workflow. Project
  automation and the Workflow's trigger state control new automatic execution, including queued
  trigger-created Runs that have not started, but not manual Runs or existing Run continuations.
- **workflow -> trace**: Phase execution supplies Phase records. Workflow owns execution truth;
  Trace owns its observations, which can be incomplete after process loss.
- **workflow -> agent**: the Workflow author selects the agents and agent invoker, supplies the
  associated accounts and credentials, and owns spending control. Kojo executes the authored
  agent calls without a separate spend-authorization contract.
- **workflow -> gate**: a Run reaches a Gate by its Gate path. Each Asking belongs to that Run and
  gets one public gate token.
- **gate -> workflow execution**: the Daemon records Verdicts and schedules Run continuations for
  answers and deadlines. A Project Runner applies them; answering clients do not execute Runs.
- **gate -> trace**: a gate writes one gate record, which carries the human latency. The gate owns
  the decision; the trace owns its measurement.
- **trace -> gate**: the Console reads the trace, and answers gates through the gate context's own
  answering half. Answering requires access as the Daemon's OS user and a token for the exact
  Asking; the Console gets no additional answering privilege. See
  [docs/adr/gate/0001-the-console-answers-by-record-and-apply.md](../adr/gate/0001-the-console-answers-by-record-and-apply.md).
- **sandbox -> trace**: each sandbox acquisition writes one sandbox record. A rebuild after a
  suspension is a second acquisition, so it is a second record.
- **sandbox and agent -> project**: execution resources have Daemon-owned Resource leases that
  survive Project Runner replacement. Trace records do not establish resource ownership or
  confirmed release.
- **trace -> workflow and project**: Artifact retention is separate from Trace-record retention.
  Workflow Revision content, execution correctness, uncertain-action evidence, and Resource leases
  remain with their owners; an Artifact reference alone does not establish a safe execution outcome.
