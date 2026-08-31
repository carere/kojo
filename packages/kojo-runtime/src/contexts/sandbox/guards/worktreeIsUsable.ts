import { Option } from "effect";
import type { WorktreeState } from "../models/WorktreeState.ts";
import type { WorktreeFault } from "../models/WorktreeUnusable.ts";
import { WorktreeUnusable } from "../models/WorktreeUnusable.ts";

/**
 * Which readings stop a run, declared rather than assumed.
 *
 * A policy exists because the four upstream skip paths are not equally alarming, and pretending they
 * are would produce a check that authors switch off wholesale. Each flag below is defended on its
 * own terms, and the defaults are what an author gets by writing nothing.
 */
export interface WorktreePolicy {
  /**
   * Stop when HEAD is detached or on another branch. Default **on**.
   *
   * This is the load-bearing one. It is the first of Sandcastle's silent skip paths and it is
   * exactly the state a suspended run can leave behind, so a rebuild that trusts the refresh can
   * hand a lane somebody else's tree and grade it without noticing.
   */
  readonly requireBranch?: boolean | undefined;
  /**
   * Stop when tracked files carry uncommitted work. Default **on**.
   *
   * Rule 2 of architecture.md §4 is that a sandbox derives from the branch alone. Uncommitted work
   * is state the branch does not carry, so a tree holding it has already broken the rule — quietly,
   * and in a way that only shows up as a mysteriously different rebuild later. Untracked files are
   * not counted, so `copyToWorktree` is unaffected.
   */
  readonly requireCommitted?: boolean | undefined;
  /**
   * Stop when `origin/<branch>` has commits the worktree does not. Default **on**.
   *
   * This is edge 3: a branch can move under a suspended run. Rebase, merge, and fail are all
   * defensible; doing one of them silently, two days later, while nobody is looking, is not. A
   * branch with no counterpart under `origin` cannot trip this.
   */
  readonly requireUpToDate?: boolean | undefined;
}

/** What an author gets by declaring nothing: all three, because each one is a lie if unchecked. */
export const strictly: Required<WorktreePolicy> = {
  requireBranch: true,
  requireCommitted: true,
  requireUpToDate: true,
};

/**
 * The first fault worth stopping for, or nothing.
 *
 * Ordered rather than collected: the faults are not independent, and a detached HEAD makes the
 * comparison with origin meaningless. Reporting the first one that holds says what to fix; reporting
 * all four would say what the first one caused.
 *
 * Pure, and deliberately so — it is the half of the re-entry check that can be tested exhaustively
 * without a repository, a container, or a clock.
 */
export const worktreeIsUsable = (input: {
  readonly branch: string;
  readonly worktreePath: string;
  readonly state: WorktreeState;
  readonly policy?: WorktreePolicy | undefined;
}): Option.Option<WorktreeUnusable> => {
  const policy = { ...strictly, ...input.policy };
  const { state } = input;

  const fault = (): WorktreeFault | undefined => {
    if (policy.requireBranch && state.detached) return "detached";
    if (policy.requireBranch && state.head !== input.branch) return "wrong-branch";
    if (policy.requireCommitted && state.modified) return "modified";
    if (policy.requireUpToDate && state.tracked && state.behind > 0) return "behind-origin";
    return undefined;
  };

  const found = fault();
  return found === undefined
    ? Option.none()
    : Option.some(
        new WorktreeUnusable({
          branch: input.branch,
          worktreePath: input.worktreePath,
          fault: found,
          state,
        }),
      );
};
