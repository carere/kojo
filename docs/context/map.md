# Context Map

Kojo uses the multi-context layout. The context slugs are the bounded contexts of
`src/contexts/<bounded-context>/`, listed in
[docs/design/typescript-effect.md §2](../design/typescript-effect.md).

## Contexts

- **workflow**: the four primitives and the contract between phases — not yet written
- **agent**: who the agents are, and one agent call — not yet written
- **sandbox**: the isolation boundary and the working copy — not yet written
- [**gate**](./gate.md): how a human is asked, and how the answer gets back
- **trigger**: what starts a run, and what it is deduplicated by — not yet written
- [**trace**](./trace.md): what a run recorded, and how a human reads it

Until a context file exists, the vocabulary table in
[docs/design/architecture.md §6](../design/architecture.md) is authoritative for that context.

`shared` is a code bucket for elements used by several contexts. It is not a bounded context, so
it has no context file and no ADR directory.

## Relationships

- **workflow -> trace**: every phase the workflow runs writes one phase record. The workflow owns
  what a phase *is*; the trace owns what a phase *recorded*.
- **gate -> trace**: a gate writes one gate record, which carries the human latency. The gate owns
  the decision; the trace owns its measurement.
- **trace -> gate**: the Console reads the trace, and answers gates through the gate context's own
  answering half. The Console gets no privilege that any other answering adapter lacks. See
  [docs/adr/gate/0001-the-console-answers-by-record-and-apply.md](../adr/gate/0001-the-console-answers-by-record-and-apply.md).
- **sandbox -> trace**: each sandbox acquisition writes one sandbox record. A rebuild after a
  suspension is a second acquisition, so it is a second record.
