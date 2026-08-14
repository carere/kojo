// This file is Kojo's own.
//
// The feature lane: new behaviour, or a change to behaviour that somebody will have to understand
// later.
//
// **What makes this lane different from the other two, on purpose:**
//
//  - **It plans first, in a file.** The planner may write inside `.scratch/` and nowhere else, and
//    that is enforced by the permission guard rather than requested by a prompt. The plan is
//    committed before the builder starts, so it lands on the branch with the work and is part of what
//    the maintainer reviews.
//  - It grades the change with the **whole fast tier** — typecheck, lint and the unit suite. That is
//    more than either other lane runs, and it is what a change to behaviour is worth.
//  - There is no gate inside the lane. The one review is the parent's, after everything has been
//    measured, which is the ordinary order — the hotfix lane is the one that inverts it.

import { Effect } from "effect";
import type { SandboxProvider } from "kojo/contexts/sandbox/models/SandboxProvider";
import { withPermissions } from "kojo/contexts/workflow/guards/Permissions";
import { agent } from "kojo/contexts/workflow/services/phase/agent";
import { commit } from "kojo/contexts/workflow/services/phase/commit";
import { sandboxed } from "kojo/contexts/workflow/services/sandboxed";
import { built as builtChecks, planned as plannedChecks } from "../../checks.ts";
import { commands } from "../../commands.ts";
import { Built, Planned } from "../../envelopes.ts";
import {
  agents,
  conventional,
  graded,
  type Judged,
  keepsItsOwnFactory,
  mayWriteCode,
  mayWriteNotesOnly,
  restore,
} from "./common.ts";

/**
 * Plan it, build it, measure it properly, hand it back.
 *
 * The `sandboxed` scope is around the phases and never inside one — see `hotfix.ts` for why that is
 * not a style choice.
 */
export const feature = (options: {
  readonly request: string;
  readonly branch: string;
  readonly provider: SandboxProvider;
}) =>
  sandboxed(
    {
      name: "feature",
      branch: options.branch,
      provider: options.provider,
      hooks: restore,
      hidden: keepsItsOwnFactory,
    },
    Effect.gen(function* () {
      // Read-only with respect to the product, writable with respect to its own notes. The prompt
      // says the same thing in words; this is the half that is a boundary.
      const plan = (yield* withPermissions(
        mayWriteNotesOnly("planner"),
        agent({
          name: "plan",
          description: "Write down how this will be made, before anybody makes it",
          agent: "planner",
          prompt: options.request,
          envelope: Planned,
          checks: plannedChecks,
        }),
      )).value;

      /**
       * **The plan is committed before the builder runs, and the ordering is load-bearing twice.**
       *
       * Once for the reason every commit in a Kojo workflow exists: the branch is the durable state,
       * and work that has not reached it does not survive a suspension.
       *
       * Once more for a reason specific to having two writing phases in one lane. `diffMatchesClaims`
       * compares an envelope's claims against everything the tree differs on **relative to HEAD**, so
       * an uncommitted plan file would appear in the builder's change-set as a path it changed and
       * did not list — and the builder would be failed for the planner's work. Committing between the
       * two phases is what keeps each agent graded on its own diff.
       */
      // `docs:` and not `feat:`, because a plan file is documentation and the two commits of this lane
      // are two different kinds of change. `plan:` is what this line said first, and Cocogitto refused
      // it — `plan` is not a commit type. See `conventional` in `common.ts`.
      yield* commit({
        name: "commit-plan",
        description: "Put the plan on this run's own branch",
        message: conventional("docs", plan.approach),
      });

      const work = (yield* withPermissions(
        mayWriteCode("builder"),
        agent({
          name: "build",
          description: "Build what the plan describes",
          agent: "builder",
          prompt: [
            options.request,
            "",
            `The plan is at: ${plan.artifacts.join(", ")}`,
            "",
            `The planner's own summary of it: ${plan.approach}`,
          ].join("\n"),
          envelope: Built,
          checks: builtChecks,
        }),
      )).value;

      yield* commit({
        name: "commit-build",
        description: "Put the built feature on this run's own branch",
        message: conventional("feat", work.summary),
      });

      // The whole fast tier. It does **not** fail when a command is red: the phase did its job, and a
      // red check is an answer the maintainer needs to see rather than a failure that hides it.
      const mechanical = yield* graded({
        name: "verify",
        description: "Typecheck, lint and run the unit tier over the built feature",
        stages: [
          ["typecheck", commands.typecheck],
          ["lint", commands.lint],
          ["unit", commands.unit],
        ],
      });

      return { lane: "feature", summary: work.summary, mechanical } satisfies Judged;
    }).pipe(Effect.provide(agents)),
  );
