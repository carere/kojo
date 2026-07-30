## Working agreements

- When you ask questions, use simple English and avoid terms that are not part of the domain language.
- Keep application-specific code inside its application.
- Prefer explicit interfaces between the CLI and visualizer.
- Add or update tests when behavior changes.
- Run `moon tasks` to know which tasks are available monorepo wide / per project.
- Do not edit generated files by hand (they are usually flagged in `biome.json`).
- Use conventional commits when committing work and creating pull requests (eg. pr's title)
- Use [cocogitto](https://docs.cocogitto.io/guide/commit.html) to create and verify commits.

## Projects

- `apps/host` contains the long-lived local Kojo Host. It owns runtime composition, Project
  Runtimes, durable state, and the local control server used by Kojo clients.
- `apps/cli` contains the terminal client. It initializes and manages Kojo Projects through the
  Kojo Host.
- `apps/visualizer` contains the browser client. Its local server communicates with the Kojo Host
  and presents Host-owned state to the browser application.
- `packages/workflow` contains `@kojo/workflow`, the public TypeScript interface used to author
  Workflow Definitions and Kojo Configuration.
- `packages/control` contains `@kojo/control`, the private versioned contract shared by the Host,
  CLI, and Visualizer.
- `tests/support` contains shared process fixtures and helpers for integration and browser tests.

## Project structure strategy

- Application behavior lives under `apps/*/src/contexts/<bounded-context>/<concept>`. Each bounded
  context owns concept folders such as `models`, `services`, `use-cases`, `guards`, `types`, `utils`,
  etc (list non-exhaustive) as they become necessary.
- Every application has a `src/contexts/shared` context. Put elements used by several bounded
  contexts there, organized by concept. For example, reusable Visualizer UI primitives live in
  `src/contexts/shared/components`, common helpers live in `src/contexts/shared/lib`, and shared API
  models, clients, and handlers live in `models`, `services`, and `server`.
- We use port / adapters architecture, so we depends on interface instead of implementation.
- Port will be interfaces or Effect Service Definition like `UserRepository` or `EmailService`, etc
- Adapters are their implementation `InMemoryUserRepository`, `ResendEmailService`, etc
- We use `Repository` when we work with data (eg. `InMemoryUserRepository`, `SQLiteUserRepository`, ...)
- We use `Service` when we don't work with data (eg. `InMemoryEmailService`, `ResendEmailService`, ...)
- `routes`, `i18n`, `styles` should stay outside of `contexts` folder.

## Testing strategy

- API handlers delegate behavior to **use cases**. Keep business decisions out of RPC handlers and
  infrastructure adapters.
- **Unit tests** exercise use cases and domain behavior through **in-memory** implementations of Effect
  services. They must not use RPC, SQLite, or the real filesystem.
- **Integration tests** exercise real adapters and boundaries. Use a real temporary SQLite database,
  real temporary files, and the RPC or HTTP boundary when those behaviors matter.
- **Browser tests** exercise SolidJS behavior in a real browser. It launches and navigates through the
  application.
- Use `@effect/vitest` for Effect-based unit and integration tests. Use its Effect-aware test
  helpers and layers so scopes and other resources are released between tests.
- Keep unit, integration, and browser tests in separate Vitest projects and Moon tasks.
- Mirror bounded-context paths beneath `tests/unit/contexts` and `tests/integration/contexts` so the
  behavior and its tests stay easy to find.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a multi-context domain-doc layout; contexts are added only when their boundaries are discovered. See `docs/agents/domain.md`.
