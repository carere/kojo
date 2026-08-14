import type { SandboxKind } from "../models/SandboxProvider.ts";

/**
 * How the factory's own files are kept out of the tree an agent works in — and what that is worth.
 *
 * The naive shape is `rm -rf .kojo`, and it is unusable. A worktree is a git worktree of the
 * repository, so a deleted tracked file is a **staged deletion waiting to happen**: `git status
 * --porcelain --untracked-files=no` answers ` D .kojo/checks.ts`, which `SandcastleSandboxSource.worktree`
 * reads and `worktreeIsUsable` turns into `WorktreeUnusable("modified")` — every acquisition of every
 * provider would fail on its first attempt. The run never even reaches the merge that would have
 * deleted `.kojo/` from the trunk. And `sandbox.close()` preserves a dirty worktree instead of
 * removing it, so every release would leak one.
 *
 * So the paths are hidden **through the index, not through the filesystem**. `git update-index
 * --skip-worktree` tells git to stop consulting the worktree for those entries; the file is then
 * deleted from disk and git still reports a clean tree, still stages nothing for them on
 * `git add --all`, and still writes the **original blobs** into every commit the run makes. Measured
 * end to end: after the mask, `git status`, `git status --untracked-files=no`, `git diff HEAD
 * --numstat` and `git ls-files --others` are all empty; the run's own commit carries
 * `.kojo/checks.ts` at its original object id; and `git merge --no-ff` lands a trunk that still holds
 * it. That is why nothing has to be restored before the merge — there is nothing to restore.
 *
 * **What this is not.** It is a filesystem-level measure against an agent that reads files, and the
 * honest claim stops there:
 *
 *  - **The git objects are still reachable.** `git show HEAD:.kojo/checks.ts` prints the file, in
 *    every provider — the parent `.git` directory is mounted into the container at its host path.
 *    Measured. `cat`, `ls` and `grep` fail; `git show` succeeds. No shape short of an orphan history
 *    closes this, and an orphan history makes the merge impossible.
 *  - **`--sandbox none` has no boundary at all.** The agent is a host process running as the same
 *    user, and the worktree sits three directories below the unmasked repository. Hiding the paths
 *    stops `cat .kojo/checks.ts` from the working directory and nothing else. See `noSandbox` in
 *    `adapters/providers.ts`.
 *  - **An isolated provider cannot be masked at all**, which is what `canHide` below is for.
 *  - **A file the agent *creates* under a hidden directory is not covered.**
 *    `.kojo/workflows/evil.ts` has no index entry, so `git add --all` stages it and the merge lands
 *    it. Measured. `withPermissions` and `factoryOwnPaths` are what catch that, which is why
 *    rollback is a second line of defence rather than a formality — `permits` returns false for that
 *    path under either write scope.
 *  - **A file created at the *root* of `.kojo/` is caught by neither line**, and this one is worth
 *    knowing before trusting the pair. `.kojo/evil.ts` is under no entry of `factoryOwnPaths`, so
 *    `permits(Unrestricted, ".kojo/evil.ts")` is **true** and no breach is raised; and it has no
 *    index entry, so the mask never saw it. See the note on `factoryOwnPaths` itself.
 *
 * Everything here is pure argv, so the whole of it is graded without a repository or a container.
 */

/**
 * Whether a worktree of this kind is the tree the agent actually reads. Isolated providers: no.
 *
 * `startSandbox` → `syncIn` runs `git bundle create --all` on the host worktree, copies the bundle
 * into the sandbox, clones it and checks the branch out there. The sandbox tree is **materialised
 * from the object database**, so `.kojo/` reappears in full no matter what the host worktree looks
 * like. Masking anyway would give the worst of both: a host worktree missing its factory, and a
 * sandbox that has it. A run that wants this protection on Vercel or Daytona has to get it from a
 * different mechanism, and pretending otherwise here would be the lie this codebase keeps catching.
 */
export const canHide = (kind: SandboxKind): boolean => kind !== "isolated";

/**
 * The author's list as git pathspecs. Blank entries go; the order and the trailing slashes stay.
 *
 * A trailing slash is a directory pathspec and git recurses it — `.kojo/workflows/` matched
 * `workflows/factory.ts` and `workflows/lane/deep.ts` in the probe — so `factoryOwnPaths` needs no
 * expansion here. Duplicates are dropped because `git ls-files` would otherwise name the same file
 * twice and `update-index` would mark it twice, which works and reads as a bug.
 */
export const pathspecsOf = (hidden: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(hidden.map((entry) => entry.trim()).filter((entry) => entry !== "")),
];

/**
 * Ask git which **tracked** files those pathspecs actually name.
 *
 * The indirection is not politeness, it is required. `update-index --skip-worktree` on a path git
 * does not track fails hard — `fatal: Unable to mark file .kojo/nothing.ts`, exit 128 — while
 * `ls-files` on a pathspec that matches nothing exits 0 and says nothing. A factory that has no
 * `.kojo/envelopes.ts` is an ordinary factory, so the list has to be narrowed to what exists before
 * anything is marked.
 *
 * `-z` because a path may contain a newline, and because git quotes such a path in the default
 * output but not in the NUL-separated one.
 */
export const listHidden = (pathspecs: ReadonlyArray<string>): ReadonlyArray<string> => [
  "ls-files",
  "-z",
  "--",
  ...pathspecs,
];

/** The paths `listHidden` found. NUL-separated, with a trailing separator git always emits. */
export const hiddenFiles = (stdout: string): ReadonlyArray<string> =>
  stdout.split("\0").filter((path) => path !== "");

/** Stop git consulting the worktree for these entries. The index itself is left untouched. */
export const hideFiles = (files: ReadonlyArray<string>): ReadonlyArray<string> => [
  "update-index",
  "--skip-worktree",
  "--",
  ...files,
];

/**
 * The first half of putting them back, and it has to be first.
 *
 * While the bit is set, `git checkout -- .kojo/checks.ts` fails with *"pathspec … did not match any
 * file(s) known to git"* — measured, and with `git checkout HEAD --` too. git will not restore a path
 * it has been told to ignore in the worktree.
 */
export const showFiles = (files: ReadonlyArray<string>): ReadonlyArray<string> => [
  "update-index",
  "--no-skip-worktree",
  "--",
  ...files,
];

/**
 * The second half: the files back on disk, from the index.
 *
 * From the index and not from `HEAD`, because the index is the copy that was never modified — it
 * still holds the blobs the worktree was cut with, even after the run has committed on top.
 */
export const restoreFiles = (files: ReadonlyArray<string>): ReadonlyArray<string> => [
  "checkout",
  "--",
  ...files,
];
