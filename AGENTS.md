When you ask questions, use simple English and avoid terms that are not part of the domain language.

## Repository structure

- `apps/cli` contains the Effect-based command-line application.
- `apps/visualizer` contains the SolidJS and Zaidan browser application.
- Application behavior lives under `apps/*/src/contexts/<bounded-context>/<concept>`. Each bounded
  context owns concept folders such as `models`, `services`, `use-cases`, `guards`, `types`, and
  `utils` as they become necessary.
- Every application has a `src/contexts/shared` context. Put elements used by several bounded
  contexts there, organized by concept. For example, reusable Visualizer UI primitives live in
  `src/contexts/shared/components`, common helpers live in `src/contexts/shared/lib`, and shared API
  models, clients, and handlers live in `models`, `services`, and `server`.
- Keep technical entry points and adapters such as styles, routes and generated i18n code outside `contexts`.
- Shared repository tasks live in `.moon/tasks`.

## Working agreements

- Keep application-specific code inside its application.
- Prefer explicit interfaces between the CLI and visualizer.
- Add or update tests with behavior changes.
- Run `moon run :check :tsc :test :integration-test :browser-test` before handing work off.
- Do not edit generated files by hand.
- Use conventional commits when committing work and creating pull requests (eg. pr's title)
- Use [cocogitto](https://docs.cocogitto.io/guide/commit.html) to create and verify commits.

## Testing strategy

- API handlers delegate behavior to use cases. Keep business decisions out of RPC handlers and
  infrastructure adapters.
- Unit tests exercise use cases and domain behavior through in-memory implementations of Effect
  services. They must not use RPC, SQLite, or the real filesystem.
- Integration tests exercise real adapters and boundaries. Use a real temporary SQLite database,
  real temporary files, and the RPC or HTTP boundary when those behaviors matter.
- Browser tests exercise SolidJS behavior in a real browser. It launches and navigates through the
  application.
- Use `@effect/vitest` for Effect-based unit and integration tests. Use its Effect-aware test
  helpers and layers so scopes and other resources are released between tests.
- Keep unit, integration, and browser tests in separate Vitest projects and Moon tasks. The default
  `test` task runs the fast unit project.
- Mirror bounded-context paths beneath `tests/unit/contexts` and `tests/integration/contexts` so the
  behavior and its tests stay easy to find.
