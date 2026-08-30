# Domain Docs

How the engineering skills should consume this repository's domain documentation.

This repository uses the **multi-context** layout.

## Before exploring, read these

- Read `docs/context/map.md` first, then read each linked context file relevant to the topic.
- Read applicable system ADRs under `docs/adr/root/`, and ADRs under each relevant
  `docs/adr/<context>/` directory.

If these files do not exist, proceed silently. Do not suggest creating them upfront. The
`/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

```text
docs/
├── context/
│   ├── map.md
│   ├── project.md
│   ├── workflow.md
│   ├── agent.md
│   ├── sandbox.md
│   ├── gate.md
│   ├── trigger.md
│   └── trace.md
└── adr/
    ├── root/        # system-wide decisions
    ├── project/
    ├── workflow/
    ├── agent/
    ├── sandbox/
    ├── gate/
    ├── trigger/
    └── trace/
```

`docs/context/map.md` is the multi-context discriminator. Use context slugs consistently between
`docs/context/<context>.md` and `docs/adr/<context>/`.

The slugs are the bounded contexts of `src/contexts/<bounded-context>/`, listed in
[docs/design/typescript-effect.md §2](../design/typescript-effect.md). `shared` is a code bucket for
elements used by several contexts, not a bounded context, so it has no context file and no ADR
directory.

## Use the context vocabulary

Use the relevant context file's terms when naming domain concepts in issues, proposals, hypotheses,
tests, and code. Do not drift to synonyms the context explicitly avoids.

`docs/context/map.md` exists, and it marks which context files are written. For a context that has
no file yet, the vocabulary table in
[docs/design/architecture.md §6](../design/architecture.md) is authoritative.

If a needed concept is absent, reconsider whether the output invents language the project does not
use. If the gap is real, note it for `/domain-modeling`.

## Flag ADR conflicts

Surface conflicts instead of silently overriding an ADR. Qualify ADR references by scope or path:

> _Contradicts `docs/adr/sandbox/0007-one-promise-boundary.md`, but worth reopening because..._
