# Version workflow authoring as an ESM compatibility boundary

Kojo will publish its complete author-facing API from the single root export of
`@kojo/workflow` as ESM JavaScript with declarations and source maps. The package exposes Workflow,
Loop, Sandbox, Agent, Command, configuration helpers, schemas, and public types while keeping the
embedded engine, persistence, and deep internals private. Repository-local Developer Workflow code
must be ESM; Kojo publishes no CommonJS build and does not expose raw TypeScript as its package
runtime artifact.

All Kojo packages are versioned together and repositories install exact project-local versions.
`@kojo/workflow` declares the exact supported Effect release as a required peer and development
dependency, and Kojo verifies that the CLI and Workflow code resolve one Effect instance. A global
CLI must delegate to the compatible project-local CLI or fail with a mismatch diagnostic.

Kojo versions its Workflow ABI independently of package SemVer. The ABI is an opaque,
monotonically changing identity included in every Workflow Revision's source fingerprint and must
match exactly for resumption. Before Kojo 1.0, an author-API or Workflow ABI break requires a minor
release; after 1.0 it requires a major release. A patch release never changes the Workflow ABI.

The initial supported matrix is Kojo `0.1.0`, Workflow ABI `1`, Effect and
`@effect/platform-bun` `4.0.0-beta.98`, Bun and `@types/bun` `1.3.14`, and TypeScript `7.0.2`.
Discovery, start, and resume reject a different CLI, `@kojo/workflow`, Effect, or Bun combination.
TypeScript is an exact tested authoring constraint but enters replay identity only if Kojo invokes
it while analyzing the executable closure. Source-independent inspection and discard remain
available despite an incompatible authoring stack.

## Considered Options

- Export authoring primitives from the internal domain or CLI packages.
- Publish raw TypeScript or parallel ESM and CommonJS builds.
- Permit broad Effect, Bun, or Kojo version ranges while Effect Workflow remains unstable.
- Treat package SemVer or the author-declared workflow version as the Workflow ABI.
- Let the newest Kojo binary force-resume older Workflow ABIs.

## Consequences

- Workflow Entry Points remain repository-local `.ts` modules. Their repository-local closure may
  use ESM TypeScript or JavaScript, including literal dynamic imports, but not CommonJS modules,
  `.cts`, `.cjs`, `require()`, or computed module specifiers.
- Kojo may fingerprint repository-relative modules, in-worktree workspace and `file:` packages,
  lockfile-resolved npm packages, and `node:` or `bun:` built-ins. Third-party packages may contain
  CommonJS internally because that does not relax the repository-authored ESM boundary.
- Kojo rejects remote imports, custom loaders or plugins, native add-ons, and local dependencies
  outside the Git worktree. Local dependency content is hashed directly; npm resolution, selected
  export conditions, lockfile integrity, and runtime identity are retained in the closure manifest.
- Newer Kojo versions keep older stores and evidence inspectable through backward-safe storage
  migrations, but do not promise to execute older Workflow ABIs. Resumption requires restoring the
  exact source and Kojo, Effect, and Bun stack; otherwise the engineer inspects or discards the run.
- The first slice has no forced resume, automatic Workflow migration, or retained executable
  snapshot. Kojo promises enough provenance and diagnostics to restore an exact revision, not
  permanent support for running it in the newest binary.
