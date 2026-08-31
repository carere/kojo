import { Effect, Schema } from "effect";
import { WorkspaceError } from "../../../sandbox/models/WorkspaceError.ts";
import { Workspace } from "../../../sandbox/ports/Workspace.ts";
import { runBranch } from "../../../shared/models/RunBranch.ts";
import { Commit } from "../../models/Commit.ts";
import { CommitRefused } from "../../models/CommitRefused.ts";
import { CurrentRun } from "../CurrentRun.ts";
import { code } from "./code.ts";

/** Who a commit is attributed to when the repository cannot say. */
export interface Author {
  readonly name: string;
  readonly email: string;
}

/** `git -c user.name=… -c user.email=…`, or nothing when the repository already knows. */
const identity = (author: Author | undefined): ReadonlyArray<string> =>
  author === undefined
    ? []
    : ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];

const lines = (output: string): ReadonlyArray<string> =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * **Agents propose, code disposes** (D6) — the disposing half.
 *
 * An agent puts a commit message on its envelope and this phase performs the commit. The split is
 * not ceremony: a commit is a known invocation, so paying an agent to rediscover `git add` every run
 * costs money and consistency, and an agent that ran the command itself could commit anything,
 * anywhere, under any message, with nothing to compare against afterwards. Here the message is the
 * agent's, and everything else is code's.
 *
 * **The branch is not a parameter.** A run owns exactly one branch, named by its run id, and this
 * phase commits to that branch or to nothing: it reads the workspace's HEAD first and refuses when
 * it is somewhere else. That is what makes "every commit an agent produces lands on the run's
 * branch" a property of the engine rather than of the author remembering.
 *
 * `files` comes back from the index — `git diff --cached --name-only` — rather than from the
 * envelope. What the agent *claimed* it changed is a claim, and `diffMatchesClaims` is what grades
 * it; this record says what git actually staged.
 */
/** @public */
export const commit = (options: {
  /** The phase name, which keys its persistence slot and its trace row. */
  readonly name?: string;
  readonly description: string;
  /** The message the agent proposed. */
  readonly message: string;
  /**
   * Who to attribute it to, for a worktree that has no identity of its own.
   *
   * Absent by default, so the repository's own configuration decides — which is the right answer
   * on a developer's machine and the wrong one inside a container that has never been configured.
   */
  readonly author?: Author;
}) =>
  code(
    {
      name: options.name ?? "commit",
      description: options.description,
      success: Commit,
      error: Schema.Union([CommitRefused, WorkspaceError]),
    },
    Effect.gen(function* () {
      const run = yield* CurrentRun;
      const workspace = yield* Workspace;
      const branch = runBranch(run.runId);

      const refuse = (reason: string) => Effect.fail(new CommitRefused({ branch, reason }));

      const head = yield* workspace.git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const on = head.stdout.trim();
      if (!head.succeeded || on !== branch) {
        return yield* refuse(
          `the workspace is on ${on === "" ? "no branch" : on}, and this run owns ${branch}`,
        );
      }

      const staged = yield* workspace.git(["add", "--all"]);
      if (!staged.succeeded) {
        return yield* refuse(`git add exited ${staged.exitCode}: ${staged.stderr.trim()}`);
      }

      const named = yield* workspace.git(["diff", "--cached", "--name-only"]);
      const files = lines(named.stdout);
      // An empty commit would put the agent's message on a change that is not there, and everything
      // downstream — the review, the merge — would then be about nothing.
      if (files.length === 0) return yield* refuse("the working tree holds no change to commit");

      const written = yield* workspace.git([
        ...identity(options.author),
        "commit",
        "--message",
        options.message,
      ]);
      if (!written.succeeded) {
        return yield* refuse(`git commit exited ${written.exitCode}: ${written.stderr.trim()}`);
      }

      const sha = yield* workspace.git(["rev-parse", "HEAD"]);
      if (!sha.succeeded) {
        return yield* refuse(`git rev-parse exited ${sha.exitCode}: ${sha.stderr.trim()}`);
      }

      return new Commit({ branch, sha: sha.stdout.trim(), message: options.message, files });
    }),
  );
