When you ask questions, use simple English and avoid terms that are not part of the domain language.

## Repository structure

- `apps/cli` contains the Effect-based command-line application.
- `apps/visualizer` contains the SolidJS and Zaidan browser application.
- Shared repository tasks live in `.moon/tasks`.

## Working agreements

- Keep application-specific code inside its application.
- Prefer explicit interfaces between the CLI and visualizer.
- Add or update tests with behavior changes.
- Run `moon run :check :tsc :test` before handing work off.
- Do not edit generated files by hand.
- Use conventional commits when committing work and creating pull requests (eg. pr's title)
- Use [cocogitto](https://docs.cocogitto.io/guide/commit.html) to create and verify commits.
