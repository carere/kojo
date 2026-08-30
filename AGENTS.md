# AGENTS.md

First read @README.md for project understanding and tooling.
Second, talk in ASD-STE100 Simplified Technical English, and use the
ubiquitous language from the domain.

## Workspace Rules

- **moon + bun monorepo, never npm.** Repo-wide checks call the tool directly, because one process
  covers the whole monorepo: `bun tsc --build`, `bun biome check .`, `bun knip`. Per-project tasks
  (dev, test, build) go through moon. `package.json` has no task scripts — the only script is the
  `prepare` hook that runs `effect-tsgo patch` on install.
- **No barrel files anywhere.** Import every symbol by its own deep path.
- **Biome** for lint/format (`bun biome check --write .` before committing). Each project carries its own
  `biome.json` with `"root": false, "extends": "//"` and its own `files.includes`.
- **Conventional Commits** enforced by [Cocogitto](https://docs.cocogitto.io/guide/commit.html)
  (`cog verify`). PR titles use the same format. English for PR title and description.

## Project structure strategy

- Application behavior lives under `{apps,packages,services}/*/src/contexts/<bounded-context>/<concept>`. Each bounded
  context owns concept folders such as `models`, `services`, `use-cases`, `guards`, `types`, `utils`,
  `components`, `hooks`, etc (list non-exhaustive) as they become necessary.
- Every application has a `src/contexts/shared/` context. Put elements used by several bounded
  contexts there, organized by concept. For example, reusable UI primitives live in
  `src/contexts/shared/components`, common helpers live in `src/contexts/shared/lib`, and shared API
  models, clients, and handlers live in `models`, `services`, etc.
- We use port / adapters architecture, so **use cases** depends on **port** that are implemented by **adapters**.
- Port will be interfaces or Effect Service Definition like `UserRepository` or `EmailService`, etc
- Adapters are their implementation `InMemoryUserRepository`, `ResendEmailService`, etc
- We use `Repository` when we work with data (eg. `InMemoryUserRepository`, `SQLiteUserRepository`, ...)
- We use `Service` when we don't work with data (eg. `InMemoryEmailService`, `ResendEmailService`, ...)
- `routes`, `i18n`, `styles` folders should stay outside of `contexts` folder.

## Testing strategy

- **Backend: Unit tests** exercise use cases (domain's invariants) through **in-memory** **adapters** (eg. `InMemoryTracer`). They must
  not use real **adapters** (eg. `SqliteTracer`).
- **Backend: Integration tests** exercise real **adapters** implementations. They must not use in-memory **adapters**.
- **Frontend: Browser / Acceptance tests** exercise user flow through the UI, using fake adapters (eg. mocked APIs / services used by the frontend).
- Use `@effect/vitest` for Effect-based backend unit and integration tests.
- use `@playwright/test` for frontend browser / acceptance tests.
- Keep unit, integration, and browser tests in separate Vitest projects and Moon tasks.
- Mirror bounded-context paths beneath `tests/unit/contexts` and `tests/integration/contexts` so the
  behavior and its tests stay easy to find.

## Source references

Both upstream projects are cloned locally for reading:

- `~/.btca/agent/sandbox/super-simple-software-factory`
- `~/.btca/agent/sandbox/sandcastle`

Sandcastle's `CONTEXT.md` is its terminology reference and worth matching where the concepts line up
(*sandbox*, *host*, *agent*, *iteration*, *branch strategy*, *agent invoker*).

## Agent skills

### Issue tracker

Issues live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Multi-context: `docs/context/map.md` plus one file per bounded context. See `docs/agents/domain.md`.
