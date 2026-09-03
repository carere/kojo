import { Effect, Schema } from "effect";
import { WorkspaceError } from "../../../sandbox/models/WorkspaceError.ts";
import { Workspace } from "../../../sandbox/ports/Workspace.ts";
import { runBranch } from "../../../shared/models/RunBranch.ts";
import type { Acceptance } from "../../models/Acceptance.ts";
import { Landing } from "../../models/Landing.ts";
import { MergeRefused } from "../../models/MergeRefused.ts";
import { NotAccepted } from "../../models/NotAccepted.ts";
import { requireAcceptance } from "../acceptance.ts";
import { CurrentRun } from "../CurrentRun.ts";
import { code } from "./code.ts";

/**
 * Land the run's branch on the target — the one step everything else was for.
 *
 * **Acceptance is the single condition it hangs on** (D7). The conjunction of the mechanical verdict
 * and the human one is checked before a single git command runs, so a run that is not accepted
 * merges *nothing*: no partial merge to unpick, no target to reset, and a branch and a trace left
 * exactly as they were for whoever comes to look. "Every phase succeeded" is not that condition,
 * and cannot be made into it — a test phase that ran a red suite succeeded.
 *
 * **A code phase, never an agent** (D6). Merging is a known invocation, it is irreversible, and it
 * is the last thing in a run that should depend on a judgement call. The author cannot hand this to
 * an agent by mistake: it takes an `Acceptance`, and only a gate and a measurement produce one.
 *
 * **The branch is not a parameter, and the workspace must be the host's.** The run owns one branch
 * and this merges that branch and no other. It runs *outside* the sandbox scope, on the host
 * workspace, because inside the scope the workspace is the worktree the branch is checked out in —
 * where the merge would be a branch into itself. Setup before, risk inside, merge after.
 */
/** @public */
export const merge = (options: {
  readonly name?: string;
  readonly description?: string;
  /** The branch the accepted work lands on. The factory's own trunk, whatever it is called. */
  readonly into: string;
  readonly acceptance: Acceptance;
  /**
   * The merge commit's own message. Absent means git writes it — `Merge branch '<run branch>'`.
   *
   * **Absent is not always a safe default, and ticket 36 is where that was measured.** A
   * `commit-msg` hook runs on a merge commit exactly as it runs on any other, so a repository that
   * enforces a commit convention refuses git's default message — and the refusal lands at the very
   * last step of a run, after the agent, the checks and the human have all said yes. Kojo's own
   * repository is such a repository: `cog verify` reads `Merge branch 'kojo/…'` as
   * `Missing commit type separator ':'`, git leaves the target mid-merge, and the phase aborts and
   * reports `MergeRefused`.
   *
   * It is the author's string rather than something the engine composes, because the convention is
   * the repository's and no engine can know it. What the engine owes the author is the door.
   */
  readonly message?: string;
}) =>
  code(
    {
      name: options.name ?? "merge",
      description: options.description ?? `Land the accepted branch on ${options.into}`,
      success: Landing,
      error: Schema.Union([NotAccepted, MergeRefused, WorkspaceError]),
    },
    Effect.gen(function* () {
      // First, and before anything that touches the repository.
      yield* requireAcceptance(options.acceptance);

      const run = yield* CurrentRun;
      const workspace = yield* Workspace;
      const branch = runBranch(run.runId);
      const into = options.into;

      const refuse = (reason: string) => Effect.fail(new MergeRefused({ branch, into, reason }));

      const head = yield* workspace.git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const on = head.stdout.trim();
      if (!head.succeeded || on !== into) {
        return yield* refuse(
          `the workspace is on ${on === "" ? "no branch" : on}, and the merge targets ${into}`,
        );
      }

      // Tracked changes only, and untracked ones too: either would be swept into a merge commit
      // nobody wrote, and both mean this is somebody's working copy rather than a clean target.
      const status = yield* workspace.git(["status", "--porcelain"]);
      if (!status.succeeded) {
        return yield* refuse(`git status exited ${status.exitCode}: ${status.stderr.trim()}`);
      }
      // Named, not counted. Ticket 47 walked into this refusal over a `node_modules/` that `kojo
      // init`'s own instructions had created, and "holds uncommitted changes" alone sent the person
      // to run `git status` themselves — the reason should carry what the refusal saw.
      const dirty = status.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (dirty.length > 0) {
        const shown = 5;
        const named =
          dirty.slice(0, shown).join(", ") +
          (dirty.length > shown ? ` — and ${dirty.length - shown} more` : "");
        return yield* refuse(`${into} holds uncommitted changes: ${named}`);
      }

      // `--no-edit` stays whether or not a message is given: it is what keeps an unattended run out
      // of an editor. `--message` is appended rather than substituted, so the shape of the command a
      // reader already knows does not change when an author supplies one.
      const merged = yield* workspace.git([
        "merge",
        "--no-ff",
        "--no-edit",
        ...(options.message === undefined ? [] : ["--message", options.message]),
        branch,
      ]);
      if (!merged.succeeded) {
        // Abort before reporting. A conflicted merge leaves the target mid-merge, which is the one
        // state a "merged nothing" claim cannot survive — and the branch is still there to try
        // again from. Best effort on purpose: if the abort itself fails, the refusal below is still
        // the more useful thing to tell a human.
        yield* Effect.ignore(workspace.git(["merge", "--abort"]));
        return yield* refuse(
          `git merge exited ${merged.exitCode}: ${(merged.stderr.trim() === "" ? merged.stdout : merged.stderr).trim()}`,
        );
      }

      const sha = yield* workspace.git(["rev-parse", "HEAD"]);
      if (!sha.succeeded) {
        return yield* refuse(`git rev-parse exited ${sha.exitCode}: ${sha.stderr.trim()}`);
      }

      return new Landing({ branch, into, sha: sha.stdout.trim() });
    }),
  );
