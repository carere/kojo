// This file is Kojo's own.
//
// The chore lane: the shape of the code changes and its behaviour does not.
//
// **What makes this lane different from the other two, on purpose:**
//
//  - **It skips planning entirely.** A rename does not need a design, and a plan file for one is a
//    file somebody has to read and nobody wanted.
//  - **It runs no tests at all.** That reads like a corner cut and it is the opposite: a chore is by
//    definition the change a suite would not notice either way, so a green suite here would be
//    evidence of nothing. What actually grades a tidy-up is the linter and the dead-code check, and
//    those are what it runs.
//  - It is the only lane whose commands can fail *because the work succeeded*: removing the last use
//    of something makes `bun knip` find it, which is exactly the signal wanted.

import type { SandboxProvider } from "@carere/kojo-runtime/contexts/sandbox/models/SandboxProvider";
import { withPermissions } from "@carere/kojo-runtime/contexts/workflow/guards/Permissions";
import { agent } from "@carere/kojo-runtime/contexts/workflow/services/phase/agent";
import { commit } from "@carere/kojo-runtime/contexts/workflow/services/phase/commit";
import { sandboxed } from "@carere/kojo-runtime/contexts/workflow/services/sandboxed";
import { Effect } from "effect";
import { built as builtChecks } from "../../checks.ts";
import { commands } from "../../commands.ts";
import { Built } from "../../envelopes.ts";
import {
  agents,
  conventional,
  graded,
  type Judged,
  keepsItsOwnFactory,
  mayWriteCode,
  restore,
} from "./common.ts";

/**
 * Tidy it, lint it, look for what it orphaned, hand it back.
 *
 * The shortest lane in the factory — three phases and a measurement — because the taxonomy earns its
 * keep at the cheap end as much as at the expensive one. A chore routed to the feature lane pays for
 * a plan nobody reads and a suite that cannot see the change.
 */
export const chore = (options: {
  readonly request: string;
  readonly branch: string;
  readonly provider: SandboxProvider;
}) =>
  sandboxed(
    {
      name: "chore",
      branch: options.branch,
      provider: options.provider,
      hooks: restore,
      hidden: keepsItsOwnFactory,
    },
    Effect.gen(function* () {
      const tidied = (yield* withPermissions(
        mayWriteCode("tidier"),
        agent({
          name: "tidy",
          description: "Change the shape and not the behaviour",
          agent: "tidier",
          prompt: options.request,
          envelope: Built,
          checks: builtChecks,
        }),
      )).value;

      // The branch is the durable state, and the parent's review gate suspends this run.
      //
      // `chore:` is this lane's own commit type, and the prefix is not cosmetic — Kojo's `commit-msg`
      // hook refuses a message that has none. See `conventional` in `common.ts`.
      yield* commit({
        name: "commit-tidy",
        description: "Put the tidy-up on this run's own branch",
        message: conventional("chore", tidied.summary),
      });

      const mechanical = yield* graded({
        name: "verify",
        description: "Lint the tidy-up and look for what it orphaned — no tests, on purpose",
        stages: [
          ["lint", commands.lint],
          ["dead code", commands.dead],
        ],
      });

      return { lane: "chore", summary: tidied.summary, mechanical } satisfies Judged;
    }).pipe(Effect.provide(agents)),
  );
