// This file is Kojo's own.
//
// The hotfix lane: something is already broken, and waiting is the expensive part.
//
// **What makes this lane different from the other two, on purpose:**
//
//  - There is no planner. A break that needs planning is not a hotfix, and the prompt tells the
//    fixer to say so rather than guess.
//  - **A human approves the fix before it is measured**, not after. That is the one inversion in this
//    factory, and it is the whole reason the lane exists: the person who was woken up can say "yes,
//    that is the fix" in seconds, and the machine can then take as long as it takes.
//  - It grades the change with the **typecheck only**. That is less than either other lane runs, and
//    it is the trade this lane is making — it buys minutes, and it pays for them in coverage.

import { Duration, Effect } from "effect";
import * as OnExpiry from "kojo/contexts/gate/models/OnExpiry";
import type { SandboxProvider } from "kojo/contexts/sandbox/models/SandboxProvider";
import { withPermissions } from "kojo/contexts/workflow/guards/Permissions";
import { agent } from "kojo/contexts/workflow/services/phase/agent";
import { commit } from "kojo/contexts/workflow/services/phase/commit";
import { reviewed } from "kojo/contexts/workflow/services/reviewed";
import { sandboxed } from "kojo/contexts/workflow/services/sandboxed";
import { built as builtChecks } from "../../checks.ts";
import { commands } from "../../commands.ts";
import { Built } from "../../envelopes.ts";
import {
  actor,
  agents,
  conventional,
  graded,
  type Judged,
  keepsItsOwnFactory,
  mayWriteCode,
  restore,
} from "./common.ts";

/** How many times the maintainer may be sent the same fix before the lane gives up. */
const askings = 3;

/**
 * A break, fixed, approved on sight, then typechecked and handed back for the final review.
 *
 * The `sandboxed` scope is **around** the phases and never inside one. A gate suspends the run by
 * interrupting it, and a phase retries on interrupt — so a sandbox acquired inside a phase would turn
 * waiting for a human into a defect. Around them, the worktree is released while the maintainer
 * thinks and rebuilt from the branch when they answer.
 */
export const hotfix = (options: {
  readonly request: string;
  readonly branch: string;
  readonly provider: SandboxProvider;
}) =>
  sandboxed(
    {
      name: "hotfix",
      branch: options.branch,
      provider: options.provider,
      hooks: restore,
      hidden: keepsItsOwnFactory,
    },
    Effect.gen(function* () {
      // `withPermissions` fingerprints the change-set, runs the phase, and compares. A path outside
      // the policy is undone and the run fails with a `PermissionBreach` naming every path and what
      // became of it — a breach is not something a re-prompt can fix, because the write already
      // happened.
      const first = (yield* withPermissions(
        mayWriteCode("fixer"),
        agent({
          name: "fix",
          description: "Write the smallest change that resolves the break",
          agent: "fixer",
          prompt: options.request,
          envelope: Built,
          checks: builtChecks,
        }),
      )).value;

      // **The branch is the durable state of a run, so the work has to be on it before anybody is
      // asked anything.** Every asking below suspends the run: the worktree is released while the
      // maintainer thinks, and Sandcastle *keeps* a dirty worktree rather than deleting it — the
      // rebuild on the answer then refuses that worktree as `WorktreeUnusable{modified}`. So an
      // uncommitted change does not merely fail to survive the gate; it stops the run being resumable
      // at all.
      // `fix:` is this lane's own commit type, and the prefix is what Kojo's `commit-msg` hook
      // requires. See `conventional` in `common.ts`.
      yield* commit({
        name: "commit-fix",
        description: "Put the fix on this run's own branch",
        message: conventional("fix", first.summary),
      });

      /**
       * **The inversion: a person approves before the machine measures.**
       *
       * A rejected fix goes back to the same agent, and the run suspends on every asking — worktree
       * released, branch retained. `limit` bounds it, and spending the bound fails the run with the
       * last reviewer's own words rather than with a wrapper.
       *
       * It is `reviewed` and not a `for` loop, and that is the one place Kojo takes control flow away
       * from an author. A durable deferred is keyed by name and refuses to be overwritten, so a
       * hand-written loop would read the *first* verdict back forever: three rounds in milliseconds,
       * one human, and a run that believes it was reviewed three times.
       */
      const approved = yield* reviewed({
        name: "approve",
        description: "A hotfix is approved before it is measured. Does this land?",
        actor,
        limit: askings,
        deadline: Duration.hours(4),
        // A hotfix nobody answered inside four hours is not a hotfix any more. Failing is the honest
        // branch: the branch and the worktree are left exactly as they are, and whoever comes back
        // starts a feature run instead.
        onExpiry: OnExpiry.fail(),
        subject: first,
        // Read again on every asking, so the second reviewer sees the *revised* fix rather than the
        // diff they already refused.
        context: (fix) => ({
          summary: fix.summary,
          files: fix.changedFiles.join(", "),
          measured: "not yet — this lane approves first",
        }),
        revise: (verdict, fix) =>
          Effect.gen(function* () {
            const revised = (yield* withPermissions(
              mayWriteCode("fixer"),
              agent({
                name: "revise",
                description: "Address the maintainer's objection",
                agent: "fixer",
                // The objection, and what the agent is being objected to. Both, because this call is
                // **cold**: `session` is what would make a revision one message rather than a fresh
                // start — give `Built` a field for the session the invoker returned and thread it
                // through here — and until that exists the previous answer has to travel in the text
                // or the fixer is asked to address a complaint about work it cannot see.
                prompt: [
                  verdict.reason,
                  "",
                  `Your previous answer was: ${fix.summary}`,
                  `It changed: ${fix.changedFiles.join(", ")}`,
                ].join("\n"),
                envelope: Built,
                checks: builtChecks,
              }),
            )).value;

            // The loop suspends again the moment this returns, so a revision has to reach the branch
            // for the same reason the first fix did. `reviewed` keys the phases inside it by asking,
            // so this is a fresh commit each round rather than a replay of the first.
            yield* commit({
              name: "commit-revision",
              description: "Put the revised fix on this run's own branch",
              message: conventional("fix", revised.summary),
            });
            return revised;
          }),
      });

      // Now the machine gets its turn. One command, and it is the fastest one that still tells the
      // truth about this repository.
      const mechanical = yield* graded({
        name: "verify",
        description: "Typecheck the approved fix — this lane runs nothing else",
        stages: [["typecheck", commands.typecheck]],
      });

      return { lane: "hotfix", summary: approved.summary, mechanical } satisfies Judged;
      // The invoker goes on the *inside* of the sandbox scope, because that is where a sandbox
      // exists. See `agents` in `common.ts`.
    }).pipe(Effect.provide(agents)),
  );
