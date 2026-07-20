import { Effect } from "effect";
import { WorkflowError } from "../types/errors";
import { runProcess, runText } from "./process";

interface GitWorktree {
  readonly branch?: string;
  readonly path: string;
}

export const parseGitWorktrees = (output: string) => {
  const worktrees: Array<GitWorktree> = [];
  let path: string | undefined;
  let branch: string | undefined;

  const flush = () => {
    if (path) {
      worktrees.push({ path, ...(branch ? { branch } : {}) });
    }
    path = undefined;
    branch = undefined;
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    } else if (line.length === 0) {
      flush();
    }
  }
  flush();

  return worktrees;
};

export const findRepositoryRoot = (cwd = globalThis.process.cwd()) =>
  runText(["git", "rev-parse", "--show-toplevel"], cwd);

export const findGitCommonDirectory = (repositoryRoot: string) =>
  runText(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryRoot);

export const listGitWorktrees = Effect.fn("listGitWorktrees")(function* (repositoryRoot: string) {
  const output = yield* runText(["git", "worktree", "list", "--porcelain"], repositoryRoot);
  return parseGitWorktrees(output);
});

export const assertValidBranchName = Effect.fn("assertValidBranchName")(function* (
  repositoryRoot: string,
  branch: string,
) {
  const valid = yield* runProcess(["git", "check-ref-format", "--branch", branch], repositoryRoot);
  if (valid.exitCode !== 0) {
    return yield* new WorkflowError({
      message: `Invalid branch name: ${branch}`,
      operation: "git.assertValidBranchName",
    });
  }
});

export const gitRefExists = Effect.fn("gitRefExists")(function* (
  repositoryRoot: string,
  reference: string,
) {
  const result = yield* runProcess(["git", "show-ref", "--verify", reference], repositoryRoot);
  return result.exitCode === 0;
});

export const assertLocalBranchExists = Effect.fn("assertLocalBranchExists")(function* (
  repositoryRoot: string,
  branch: string,
) {
  yield* assertValidBranchName(repositoryRoot, branch);

  if (!(yield* gitRefExists(repositoryRoot, `refs/heads/${branch}`))) {
    return yield* new WorkflowError({
      message: `Local branch '${branch}' does not exist`,
      operation: "git.assertLocalBranchExists",
    });
  }
});

export const worktreeStatus = (path: string) =>
  runText(["git", "status", "--porcelain", "--untracked-files=all"], path);
