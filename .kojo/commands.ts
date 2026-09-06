// This file is Kojo's own.
//
// Every real invocation Kojo's factory makes. **None of them is a placeholder** — this is the file a
// freshly stamped factory lies in, and the first thing a person is told to finish.

import { isPlaceholder } from "@carere/kojo-runtime/contexts/workflow/models/Placeholder";

/**
 * What a code phase of Kojo's factory runs, in the run's own worktree.
 *
 * Repo-wide checks call their tools directly. Unit tests use the Moon tasks for the CLI,
 * Runtime, Runner contracts, and Client contracts packages.
 *
 * `install` is the one entry that is knowledge rather than a choice: the lockfile says bun, and
 * `--frozen-lockfile` is not decoration. A plain `bun install` may rewrite `bun.lock`, and a rewritten
 * lockfile is an unclaimed change in the working tree — which `diffMatchesClaims` correctly reads as
 * the agent having touched a file it did not report. The flag is what keeps the tree clean enough for
 * the checks to mean what they say.
 *
 * CI runs integration and browser tests. This Factory uses the unit tier for fast feedback.
 */
export const commands = {
  /**
   * Restore dependencies in the run's own worktree. bun, from `bun.lock`.
   *
   * **Read by a sandbox hook rather than by a phase** — see `restore` in `workflows/lane/common.ts`
   * for the run that proved why. It is still here because this file is where a factory writes down
   * what it invokes, and a hook is an invocation.
   */
  install: "bun install --frozen-lockfile",

  /** Typecheck every project reference and the standalone Factory. */
  typecheck: "bun tsc --build && bun tsc --project .kojo/tsconfig.json",

  /** Lint and format, repo-wide. Read-only: `check` without `--write` reports, it does not fix. */
  lint: "bun biome check .",

  /** The unit tier: use cases through in-memory adapters. */
  unit: "moon run kojo:test kojo-runtime:test kojo-runner-contracts:test kojo-client-contracts:test",

  /** Dead-code analysis. The check a tidy-up is actually graded by. */
  dead: "bun knip",
} as const;

/**
 * Which commands are still fake. **None, and this function stays anyway.**
 *
 * `kojo doctor` asks this question of every factory, and it asks it by importing this module and
 * calling this export — so a factory that answered by not having the function would be answered by
 * `doctor`'s weaker fallback instead. `isPlaceholder` is Kojo's own, so the test is the same on both
 * sides and a half-edited command that kept the marker is still caught.
 *
 * @public
 */
export const survivingPlaceholders = (): ReadonlyArray<string> =>
  Object.entries(commands)
    .filter(([, command]) => isPlaceholder(command))
    .map(([name]) => name);
