import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import {
  assertValidBranchName,
  gitRefExists,
  listGitWorktrees,
  worktreeStatus,
} from "../../shared/git";
import { runRequired, runText } from "../../shared/process";
import { WorkflowError } from "../../types/errors";
import { createPreviewIdentity } from "./identity";

export const hasPreviewBlockingChanges = (statusOutput: string) =>
  statusOutput
    .split("\n")
    .filter(Boolean)
    .some((line) => line !== "?? .protolock");

const canonicalPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const assertWorktreeIsClean = Effect.fn("assertWorktreeIsClean")(function* (
  worktreePath: string,
  branch: string,
) {
  const status = yield* worktreeStatus(worktreePath);
  if (hasPreviewBlockingChanges(status)) {
    return yield* new WorkflowError({
      message: `Branch '${branch}' is checked out at '${worktreePath}' with uncommitted changes. Commit or stash them before starting an exact branch preview.`,
      operation: "preview.assertWorktreeIsClean",
    });
  }
});

export const resolveWorktree = Effect.fn("resolveWorktree")(function* (
  repositoryRoot: string,
  branch: string,
) {
  yield* assertValidBranchName(repositoryRoot, branch);
  const localReference = `refs/heads/${branch}`;
  const hasLocalBranch = yield* gitRefExists(repositoryRoot, localReference);
  const remoteReference = `refs/remotes/origin/${branch}`;
  if (!hasLocalBranch) {
    yield* runRequired(
      ["git", "fetch", "origin", `+refs/heads/${branch}:${remoteReference}`],
      repositoryRoot,
    );
    if (!(yield* gitRefExists(repositoryRoot, remoteReference))) {
      return yield* new WorkflowError({
        message: `Branch '${branch}' does not exist locally or on origin`,
        operation: "preview.resolveWorktree",
      });
    }
  }

  const reference = hasLocalBranch ? localReference : remoteReference;
  const revision = yield* runText(
    ["git", "rev-parse", "--verify", `${reference}^{commit}`],
    repositoryRoot,
  );
  const identity = createPreviewIdentity(branch, repositoryRoot);
  const previewPath = resolve(
    repositoryRoot,
    ".sandcastle",
    "worktrees",
    "previews",
    identity.containerName,
  );
  const worktrees = yield* listGitWorktrees(repositoryRoot);
  const canonicalPreviewPath = canonicalPath(previewPath);
  const existing = worktrees.find(
    (worktree) => canonicalPath(worktree.path) === canonicalPreviewPath,
  );

  if (existing) {
    yield* assertWorktreeIsClean(existing.path, branch);
    yield* runRequired(["git", "checkout", "--detach", revision], existing.path);
    yield* assertWorktreeIsClean(existing.path, branch);
    return previewPath;
  }

  // A detached worktree lets a branch be previewed even while it is checked out elsewhere.
  // The command must settle: interrupting Git mid-registration can leave shared metadata stale.
  yield* runRequired(
    ["git", "worktree", "add", "--detach", previewPath, revision],
    repositoryRoot,
  ).pipe(Effect.uninterruptible);
  yield* assertWorktreeIsClean(previewPath, branch);
  return previewPath;
});
