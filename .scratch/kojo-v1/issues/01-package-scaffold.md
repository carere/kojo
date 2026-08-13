# 01 — Package scaffold for the kojo package

**What to build:** The published package exists and every repo-wide check passes against it. A contributor can clone, install, and run the three checks green before a single line of behaviour exists. Dependencies are pinned at the versions the API audit was performed against — drifting off them invalidates the audit.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `bun tsc --build` succeeds across every project reference
- [x] `bun biome check .` passes, with the package carrying its own config extending the root
- [x] `bun knip` reports no dead code
- [x] The package's moon test task runs and passes with zero tests
- [x] Effect and its adapters are pinned exactly at the audited versions, not a range
- [x] No barrel files; the deep-import surface is the only surface

## Comments

Done. Four checks green: `bun tsc --build`, `bun biome check .`, `bun knip`, `moon run kojo:test`.

Deviations and incidental fixes, all deliberate:

- **Two tests instead of zero.** Vitest fails a project with no test files, so a passing harness is
  better proven by a passing test. `RunId` is the first shared model and needed writing anyway.
- **`allowImportingTsExtensions` added to the root tsconfig options.** The package's export map is
  `./src/*.ts` and bun runs TypeScript directly, so `.ts` import specifiers are correct here.
- **`@effect/language-service` added as a root dev dependency.** Knip flagged it as unlisted — a
  pre-existing gap that could not surface until a TypeScript project existed to analyse.
- **The root tsconfig reference was added by hand.** Moon's project sync does not add it, because
  the root project does not declare a dependency on the package.
- **`bun tsc --build` was proven able to fail** before being trusted — an empty references array
  made it exit 0 while checking nothing.

Note for later: the root `package.json` and this package are both named `kojo`. Harmless today,
but worth renaming the root if `bun add -F kojo` ever becomes ambiguous.
