import { Schema } from "effect";
import { WorktreeState } from "./WorktreeState.ts";

/**
 * Why a worktree is not the branch the run believes it is on.
 *
 * One literal per silent skip path that could have produced it, so the failure names the upstream
 * behaviour it caught rather than describing a symptom.
 */
export const WorktreeFault = Schema.Literals([
  /** HEAD is detached. The run's commits would land on nothing a branch can be resumed from. */
  "detached",
  /** HEAD is on some other branch. The rebuild would grade a tree from a different run. */
  "wrong-branch",
  /** Tracked files carry uncommitted work, so the branch is not the whole state after all. */
  "modified",
  /** Somebody pushed while the run waited, and the fast-forward that should have happened did not. */
  "behind-origin",
]);
export type WorktreeFault = typeof WorktreeFault.Type;

/**
 * The worktree a sandbox was built on is not what the run needs it to be, and Kojo says so out loud.
 *
 * Failing loudly is the honest default (architecture.md §8, edge 3). The alternative on offer —
 * rebase or merge under a run that has been suspended for two days — is a decision with
 * consequences, and making it silently on a human's behalf while they are not looking is how a
 * factory produces a branch nobody can explain. A run that stops here still has its branch and its
 * worktree intact for a person to look at.
 *
 * A `Schema.TaggedError` because it travels a workflow error channel, and the engine persists what
 * it records.
 */
export class WorktreeUnusable extends Schema.TaggedError<WorktreeUnusable>()("WorktreeUnusable", {
  /** The branch the run asked for, which is not necessarily the one it got. */
  branch: Schema.String,
  worktreePath: Schema.String,
  fault: WorktreeFault,
  /** The whole reading, so a human does not have to re-derive it from one field. */
  state: WorktreeState,
}) {
  /**
   * One sentence for a human, because a report that repeats the fields adds nothing.
   *
   * A record rather than a `switch`, and only because the linter cannot see that an exhaustive
   * switch over a literal union always returns. The record is exhaustive by its own type, which is
   * the same guarantee stated where a tool can read it.
   */
  get summary(): string {
    const said: Record<WorktreeFault, string> = {
      detached: `the worktree at ${this.worktreePath} has a detached HEAD, not ${this.branch}`,
      "wrong-branch": `the worktree at ${this.worktreePath} is on ${this.state.head}, not ${this.branch}`,
      modified: `the worktree at ${this.worktreePath} holds uncommitted work on ${this.branch}`,
      "behind-origin": `${this.branch} is ${this.state.behind} commits behind origin, and the refresh did not say so`,
    };
    return said[this.fault];
  }
}
