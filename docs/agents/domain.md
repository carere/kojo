# Domain Docs

How the engineering skills should consume this repository's domain documentation.

## Before exploring, read these

- Read `docs/context/map.md` first, then read each linked context file relevant to the topic.
- Read applicable system ADRs under `docs/adr/root/`.
- Read applicable context ADRs under each relevant `docs/adr/<context>/` directory.

If these files do not exist, proceed silently. Do not suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

This is a multi-context project:

```text
docs/
├── context/
│   ├── map.md
│   └── <context>.md
└── adr/
    ├── root/
    └── <context>/
```

`docs/context/map.md` is the multi-context discriminator. Use context slugs consistently between `docs/context/<context>.md` and `docs/adr/<context>/`.

No bounded contexts have been named yet. Do not treat application, package, or placeholder folder names as domain boundaries. Add context files and ADR directories only after the boundaries and their slugs have been confirmed.

## Use the context vocabulary

Use the relevant context file's terms when naming domain concepts in issues, proposals, hypotheses, tests, and code. Do not drift to synonyms the context explicitly avoids.

If a needed concept is absent, reconsider whether the output invents language the project does not use. If the gap is real, note it for `/domain-modeling`.

## Flag ADR conflicts

Surface conflicts instead of silently overriding an ADR. Qualify ADR references by scope or path:

> _Contradicts `docs/adr/ordering/0007-event-sourced-orders.md`, but worth reopening because..._
