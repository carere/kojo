# Use the repository `.kojo` directory for Workflow source

Kojo will use a Project's root `.kojo/` directory for committed Developer Workflow source and
supporting files while keeping `kojo.config.ts` at the repository root as the fixed Workflow
Registry entry point. The directory will never hold Kojo Home state, runtime data, caches, or
secrets; installation-wide state remains centralized in Kojo Home as established by
[`0010-centralize-project-and-run-state-in-kojo-home.md`](./0010-centralize-project-and-run-state-in-kojo-home.md).

## Considered Options

- Put repository-authored Workflow source in a visible root `workflows/` directory.
- Use the repository `.kojo/` directory for both authored source and local runtime state.
- Put `kojo.config.ts` inside `.kojo/` with the Workflow source.

## Consequences

- Project Initialization creates example source under `.kojo/workflows/` and leaves
  `kojo.config.ts` at the repository root.
- The repository `.kojo/` directory must be committed and must not be ignored by Git.
- The same basename has two clearly separated scopes: repository `.kojo/` is authored source,
  while the user-scoped `~/.kojo/` is Kojo Home.
- Generated examples and supporting files participate normally in Workflow Revision source
  fingerprinting when they are reachable from a Workflow Entry Point.
