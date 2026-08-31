import { Schema } from "effect";

/**
 * What the worktree actually is at the moment a sandbox scope is entered — read, never assumed.
 *
 * "The branch is the durable state" is the central claim of this design, and the only thing that
 * makes it true is that somebody checks. Sandcastle's worktree refresh is best-effort and has
 * **four** silent skip paths — HEAD not on the branch, a fetch that failed, local divergence from
 * origin, and a dirty worktree — and every one of them reuses the worktree as it stands behind a log
 * line. The first is exactly the state a suspended run leaves. So Kojo reads the tree itself on
 * every acquisition instead of trusting that a refresh happened.
 *
 * Every field is an observation. What is *acceptable* is a separate question, and it lives in
 * `guards/worktreeIsUsable.ts`, so the reading cannot quietly become the policy.
 */
export class WorktreeState extends Schema.Class<WorktreeState>("WorktreeState")({
  /** The branch HEAD points at. Empty when HEAD is detached — see `detached`. */
  head: Schema.String,
  /** A detached HEAD names no branch, so `head` cannot carry the fact and this field does. */
  detached: Schema.Boolean,
  /**
   * Tracked files carry uncommitted changes.
   *
   * **Tracked only.** Untracked files are not dirt: `copyToWorktree` puts an `.env` and a config
   * into the worktree before the sandbox starts, by design, and a check that read those as damage
   * would fail every run that uses the feature.
   */
  modified: Schema.Boolean,
  /** The branch has a counterpart under `origin`. Nothing below it means anything when this is false. */
  tracked: Schema.Boolean,
  /** Commits on `origin/<branch>` that the worktree does not have. Somebody pushed while it waited. */
  behind: Schema.Finite,
  /** Commits the worktree has that `origin/<branch>` does not. This is the run doing its job. */
  ahead: Schema.Finite,
}) {}
