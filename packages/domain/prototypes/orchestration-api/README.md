# PROTOTYPE — Kojo's Effect-native orchestration API

This throwaway prototype records the answer to:

> What is the smallest Effect-native public API that lets repository-local Workflows compose
> durable operations and Loops without hiding ordinary Effect control flow?

It shows the validated shape against four authoring stories. The code snippets are discussion
artifacts, not an implementation and not a promise that every name survives into production.

Run it from the repository root:

```sh
moon run domain:prototype-orchestration-api
```

Use the terminal controls to move through the stories.

## Validated public surface

- `Workflow.make` / `workflow.run`
- `Loop.run`
- `Sandbox.use`
- `Agent.run`
- `Command.run`

## Settled constraints

- There is one `Workflow` primitive. Calling a Workflow from another Workflow creates a linked
  durable Workflow Run; it is not a different kind of definition.
- A Workflow is an ordinary Effect program with input, success, and failure schemas. A stable name
  plus declared version identifies its Workflow Revision; Kojo adds the source fingerprint when the
  CLI loads the module.
- `Loop.run` coordinates Activities but is not itself an Activity. The author supplies an Effect
  function, a positive maximum iteration count, and a pure `repeatWhile` condition over the
  function's successful result.
- A Loop supplies its name and current iteration to the internal Activity identity context, so the
  author does not manually thread iteration numbers through `Agent.run` and `Command.run`.
- A Loop returns the first result for which `repeatWhile` is false. If the condition is still true
  at the maximum, it fails with `Loop.MaxIterationsReached`. An Effect failure from the body stops
  the Loop immediately.
- A Reusable Sandbox is a named, scoped, process-local handle. Replay recreates it from the same
  branch; the handle is never encoded as workflow state.
- `Agent.run` and `Command.run` return schema-checked results. Those journaled results and their
  trace metadata are the evidence; there is no separate `Evidence` authoring primitive.
- A nonzero command exit is an observed `CommandResult`, so a Loop condition can inspect it.
  Infrastructure failures that prevent Kojo from observing a result remain Effect failures.
- A recursively invoked Workflow does not share a Sandbox implicitly.

## Extending Kojo

`Activity` is not a Kojo public primitive. It remains available from `effect/unstable/workflow` for
authors who need to build a repository-local durable primitive that the built-ins do not cover.
Kojo documents the identity and replay requirements but does not wrap or re-export `Activity`.
