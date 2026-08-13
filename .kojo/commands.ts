// This file is Kojo's own.
//
// Every real invocation Kojo's factory makes. **None of them is a placeholder** — this is the file a
// freshly stamped factory lies in, and the first thing a person is told to finish.

import { isPlaceholder } from "kojo/contexts/scaffold/models/Placeholder";

/**
 * What a code phase of Kojo's factory runs, in the run's own worktree.
 *
 * Every one of these is a command CLAUDE.md already names, copied rather than invented, because a
 * factory whose checks disagree with the repository's own checks grades something nobody else does.
 * The repo-wide ones call the tool directly — one process covers the whole monorepo — and the suite
 * goes through the project's own Vitest binary rather than through moon, for a reason worth writing
 * down: moon resolves its toolchain against the workspace it is standing in, and a run stands in a
 * linked worktree with no `.moon/cache`, so the first phase of every run would pay for a toolchain
 * install before it ran a test. Vitest needs neither.
 *
 * `install` is the one entry that is knowledge rather than a choice: the lockfile says bun, and
 * `--frozen-lockfile` is not decoration. A plain `bun install` may rewrite `bun.lock`, and a rewritten
 * lockfile is an unclaimed change in the working tree — which `diffMatchesClaims` correctly reads as
 * the agent having touched a file it did not report. The flag is what keeps the tree clean enough for
 * the checks to mean what they say.
 *
 * **What is deliberately not here: the integration tier.** `moon run kojo:test-integration` builds
 * Docker containers, so a phase that ran it inside a container would need docker-in-docker, and a
 * phase that ran it on the host would spend minutes per run on the one tier CI is for. Kojo's factory
 * therefore grades a change on the fast, deterministic half and leaves the container tier to CI. That
 * is a decision, and it is written here rather than left as an absence — see `.kojo/README.md`.
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

  /** Typecheck every project reference. The fastest signal that is still a real one. */
  typecheck: "bun tsc --build",

  /** Lint and format, repo-wide. Read-only: `check` without `--write` reports, it does not fix. */
  lint: "bun biome check .",

  /** The unit tier: use cases through in-memory adapters. */
  unit: "cd packages/kojo && bun node_modules/.bin/vitest run --project unit",

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
