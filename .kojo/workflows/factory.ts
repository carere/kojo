// This file is Kojo's own factory, and it is the one used to develop Kojo.
//
// Start it with `kojo workflow start <project-id> factory --payload '{"request":"..."}'`.
//
// It is architecture.md §3 as a program: a router reads the request and names a lane, the lanes
// differ from each other on purpose, and every path then passes one human review before a code phase
// lands it. Nothing here is a Kojo API deciding the lanes — the taxonomy is in `envelopes.ts`, the
// three lanes are in `workflows/lane/`, and the `Match` below is ordinary control flow.
//
// Three things about the shape are worth keeping when you edit it:
//
//  - The `sandboxed` scopes are **around** the phases, never inside one. A gate suspends the run by
//    interrupting it, and a phase retries on interrupt — so a sandbox acquired inside a phase turns
//    waiting for a human into a defect.
//  - A loop that contains a gate must be `reviewed`, never `while` or `for`. The hotfix lane has the
//    only one in this factory. Every other loop can be plain control flow.
//  - Nothing irreversible happens outside a phase. A workflow body replays from the top on every
//    resume; only a phase's recorded result is replayed instead of re-run. That is why the target
//    branch below is *read in a phase* rather than read here.

import { AgentInvocationError } from "@carere/kojo-runtime/contexts/agent/models/AgentInvocationError";
import { RosterError } from "@carere/kojo-runtime/contexts/agent/models/RosterError";
import { GateExpired } from "@carere/kojo-runtime/contexts/gate/models/GateExpired";
import { GateRejected } from "@carere/kojo-runtime/contexts/gate/models/GateRejected";
import { GateUnreachable } from "@carere/kojo-runtime/contexts/gate/models/GateUnreachable";
import * as OnExpiry from "@carere/kojo-runtime/contexts/gate/models/OnExpiry";
import { noSandbox } from "@carere/kojo-runtime/contexts/sandbox/adapters/providers";
import { SandboxError } from "@carere/kojo-runtime/contexts/sandbox/models/SandboxError";
import { WorkspaceError } from "@carere/kojo-runtime/contexts/sandbox/models/WorkspaceError";
import { WorkspaceUnreachable } from "@carere/kojo-runtime/contexts/sandbox/models/WorkspaceUnreachable";
import { WorktreeUnusable } from "@carere/kojo-runtime/contexts/sandbox/models/WorktreeUnusable";
import { Workspace } from "@carere/kojo-runtime/contexts/sandbox/ports/Workspace";
import { runBranch } from "@carere/kojo-runtime/contexts/shared/models/RunBranch";
import { withPermissions } from "@carere/kojo-runtime/contexts/workflow/guards/Permissions";
import { Acceptance } from "@carere/kojo-runtime/contexts/workflow/models/Acceptance";
import { CheckViolation } from "@carere/kojo-runtime/contexts/workflow/models/CheckViolation";
import { CommitRefused } from "@carere/kojo-runtime/contexts/workflow/models/CommitRefused";
import { EnvelopeParseError } from "@carere/kojo-runtime/contexts/workflow/models/EnvelopeParseError";
import { MergeRefused } from "@carere/kojo-runtime/contexts/workflow/models/MergeRefused";
import { NotAccepted } from "@carere/kojo-runtime/contexts/workflow/models/NotAccepted";
import { PermissionBreach } from "@carere/kojo-runtime/contexts/workflow/models/PermissionBreach";
import { fromVerdict } from "@carere/kojo-runtime/contexts/workflow/services/acceptance";
import { CurrentRun } from "@carere/kojo-runtime/contexts/workflow/services/CurrentRun";
import { agent } from "@carere/kojo-runtime/contexts/workflow/services/phase/agent";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { gate } from "@carere/kojo-runtime/contexts/workflow/services/phase/gate";
import { merge } from "@carere/kojo-runtime/contexts/workflow/services/phase/merge";
import { sandboxed } from "@carere/kojo-runtime/contexts/workflow/services/sandboxed";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";
import { Duration, Effect, Match, Schema } from "effect";
import { Routed } from "../envelopes.ts";
import { chore } from "./lane/chore.ts";
import { actor, agents, conventional, keepsItsOwnFactory, mayWriteNothing } from "./lane/common.ts";
import { feature } from "./lane/feature.ts";
import { hotfix } from "./lane/hotfix.ts";

/**
 * The branch Kojo's own factory refuses to land on, ever.
 *
 * Not a preference. Kojo's history goes onto `main` through a reviewed feature branch, so a run that
 * merged straight there would be work that skipped the process the repository exists to run. The
 * refusal is in a phase below, where it is recorded, rather than in a comment nobody executes.
 */
const forbidden = "main";

/**
 * Where the work runs: **on this machine, in the run's own worktree.**
 *
 * `noSandbox()` is a real answer here rather than an opt-out — the scope still cuts the run's branch,
 * still hands every phase a `Workspace` over that worktree, and still tears the whole thing down at a
 * suspension. What it does not do is start a container, and for *this* repository that is the correct
 * call rather than the cheap one:
 *
 *  - Kojo's integration tier drives Docker itself. A phase that ran it inside a container would need
 *    docker-in-docker; a factory whose reference sandbox cannot host its own test suite should say so
 *    instead of pretending.
 *  - The toolchain is pinned by `.prototools` and restored by `bun install`. An image that reproduced
 *    it would be a second copy of both, to keep in step by hand, and the first thing to drift would
 *    be the thing the checks run on.
 *
 * Turning this factory into a containerised one is one expression: import `docker` beside `noSandbox`
 * and return `docker({ imageName: "kojo-factory:latest" })`. It is built per run rather than held as
 * a module constant, because a provider is the only place a run's own environment can be attached —
 * `CreateSandboxOptions` carries no `env`.
 */
const provider = () => noSandbox();

/**
 * Every way this workflow can fail. The engine persists it, so it has to be a schema.
 *
 * All three lanes are covered by one union because the parent must not be able to tell them apart —
 * it asks one human and performs one merge whichever lane ran. `CommitRefused` is on it because the
 * lanes use the engine's own `commit` phase, which refuses to commit anywhere but the run's branch.
 */
const failures = Schema.Union([
  AgentInvocationError,
  CheckViolation,
  CommitRefused,
  EnvelopeParseError,
  GateExpired,
  GateRejected,
  GateUnreachable,
  MergeRefused,
  NotAccepted,
  PermissionBreach,
  RosterError,
  SandboxError,
  WorkspaceError,
  WorkspaceUnreachable,
  WorktreeUnusable,
]);

/**
 * Kojo's own factory.
 *
 * `@public` because nothing in this repository imports it: the Daemon captures this module as a
 * Workflow Revision. The loader refuses a file that exports two, and
 * refuses one whose declared name is not the file name — so this export is the whole purpose of the
 * file, and an unused-export report about it would be a report about the design working.
 *
 * @public
 */
export const factory = workflow(
  {
    name: "factory",
    payload: { request: Schema.String },
    success: Schema.String,
    error: failures,
    // What a run is deduplicated by. Two triggers naming one unit of work must not open two runs,
    // and this string is what the engine hashes into the run id — which is also why re-running a
    // failed request replays the failure instead of retrying it. A retry needs a new request.
    idempotencyKey: (payload) => `factory/${payload.request}`,
  },
  (payload) =>
    Effect.gen(function* () {
      /**
       * **The run names its own branch, and nothing tells it what to call it.**
       *
       * `runBranch` is a function of the run id and of nothing else, so a resumed run in another
       * process two days later derives the same name from the same run without carrying it. It is
       * also what lets `commit` and `merge` refuse to act on any other branch.
       */
      const run = yield* CurrentRun;
      const branch = runBranch(run.runId);

      /**
       * **Where an accepted run lands, decided once and recorded.**
       *
       * The trunk is *the branch this repository was on when the run started*, not a constant. That
       * is the only answer that is right for Kojo: its trunk moves — `main`, then a long-lived
       * `feat/*` branch — the run's own branch is forked from wherever HEAD was, and merging back
       * anywhere else would put work on a branch it was never based on.
       *
       * It is read **inside a phase** for the reason the header gives. A body replays from the top,
       * so a `git rev-parse` out in the open would be re-read on the resume — days later, from
       * whatever branch somebody happens to have checked out — and the merge would target a branch
       * the run had never heard of. In a phase it is recorded once and replayed unchanged.
       *
       * `main` is refused by name. See `forbidden`.
       */
      const target = yield* code(
        {
          name: "target",
          description: "Record the branch this run will land on, before anything can move it",
          success: Schema.String,
          // `WorkspaceError` is on the channel because reading HEAD goes through the port and the
          // port can fail. A phase that declared only its own refusal would not compile, which is
          // the typed error channel doing its job on the first line that touches git.
          error: Schema.Union([MergeRefused, WorkspaceError]),
        },
        Effect.gen(function* () {
          const workspace = yield* Workspace;
          const head = yield* workspace.git(["rev-parse", "--abbrev-ref", "HEAD"]);
          const on = head.stdout.trim();
          const refuse = (reason: string) =>
            Effect.fail(new MergeRefused({ branch, into: on, reason }));

          if (!head.succeeded || on === "" || on === "HEAD") {
            return yield* refuse(
              "this repository is not on a branch, so there is nowhere for the run to land. " +
                "Check one out before starting a run",
            );
          }
          if (on === forbidden) {
            return yield* refuse(
              `Kojo's own factory does not land on \`${forbidden}\`. Its history reaches ` +
                `\`${forbidden}\` through a reviewed feature branch, so check one out and run again`,
            );
          }
          return on;
        }),
      );

      /**
       * **Routing is an agent decision, and it happens before any lane exists.**
       *
       * The envelope does not only carry context forward — its `lane` selects the next subgraph. That
       * is the property architecture.md §3 puts the router in to demonstrate, and it is why the
       * router runs *outside* every lane: it decides which lane runs.
       *
       * It still needs a scope, because an agent runs somewhere and reads something. This one is the
       * host: `noSandbox()` over the run's own branch, so the router reads the same tree the lane
       * will work in. The router is barred from writing anything at all — see `mayWriteNothing`.
       *
       * The cost of a separate scope is honest and worth naming: a resume re-enters this scope as
       * well as the lane's, so a run that suspends at the review gate rebuilds two worktrees on the
       * way back. On `noSandbox` that is two git operations. On a container provider it would be two
       * container builds, and the answer then would be to hoist the router into the lane.
       */
      const routed = yield* sandboxed(
        { name: "route", branch, provider: provider(), hidden: keepsItsOwnFactory },
        withPermissions(
          mayWriteNothing("router"),
          agent({
            name: "route",
            description: "Read the request and name the lane that fits it",
            agent: "router",
            prompt: payload.request,
            envelope: Routed,
            // No checks. The decoder already refuses any lane that is not one of the three, and a
            // check that re-asserted it would grade nothing. See `envelopes.ts`.
          }),
        ).pipe(Effect.provide(agents)),
      );
      const lane = routed.value.lane;

      /**
       * **The lanes, and the point of having more than one.**
       *
       * `Match` on the router's own answer. Plain control flow expresses this — no node-and-edge DSL
       * — and each branch is a whole subgraph with its own sandbox scope, its own agents, its own
       * commands and, in the hotfix case, its own gate.
       *
       * What differs, and why each difference is one a Kojo maintainer would want:
       *
       * | | planning | grades the change with | human asked inside the lane |
       * |---|---|---|---|
       * | `hotfix` | none | typecheck | **yes — before it is measured** |
       * | `feature` | a plan file, committed first | typecheck, lint, unit | no |
       * | `chore` | none | lint, dead code — **no tests** | no |
       *
       * `Match.exhaustive` is what makes adding a fourth lane to `envelopes.ts` a compile error here
       * rather than a run that silently falls through.
       */
      const judged = yield* Match.value(lane).pipe(
        Match.when("hotfix", () =>
          hotfix({ request: payload.request, branch, provider: provider() }),
        ),
        Match.when("feature", () =>
          feature({ request: payload.request, branch, provider: provider() }),
        ),
        Match.when("chore", () =>
          chore({ request: payload.request, branch, provider: provider() }),
        ),
        Match.exhaustive,
      );

      /**
       * **The one place judgement happens on every path. Everything after it is consequence.**
       *
       * It is outside every sandbox scope, which is the cheapest place a gate can be: the run holds
       * no worktree and no container while it waits, and the process that started it is free to exit.
       * A Gate answer through the Daemon resumes it — an hour later or on Monday.
       *
       * The description carries what the reviewer needs and nothing they would have to go and find:
       * which lane ran, what the agent said it did, and what this lane's own commands measured.
       */
      const verdict = yield* gate({
        name: "review",
        description: [
          `Land this ${judged.lane} on \`${target}\`?`,
          "",
          judged.summary,
          "",
          `${judged.mechanical.by}: ${judged.mechanical.reason}`,
        ].join("\n"),
        actor,
        choices: ["approve", "reject"],
        deadline: Duration.days(2),
        // Nobody answering in two days is not an approval. The branch and its worktree are left
        // exactly as they are for whoever comes to look.
        onExpiry: OnExpiry.fail(),
      });

      /**
       * **The step everything else was for: the accepted work lands on the target branch.**
       *
       * Three things about this line are the design rather than a choice:
       *
       *  - **Acceptance is the single condition it hangs on** — the conjunction of what this lane's
       *    commands measured and what the maintainer decided. Either half refusing merges *nothing*:
       *    the run fails with `NotAccepted`, the target is untouched, and the branch is left exactly
       *    as it is. "Every phase succeeded" is not that condition and cannot be made into it — a
       *    `verify` phase that ran a red typecheck succeeded.
       *  - **It is a code phase, and an agent never runs it.** The engine will not let you hand it to
       *    one: it takes an `Acceptance`, and only a gate and a measurement produce one.
       *  - **It is outside the sandbox scope, on purpose.** Inside, the workspace is the worktree this
       *    run's branch is checked out in, and merging the branch there would be merging a branch into
       *    itself. Out here the workspace is the repository the run was started from. Setup before,
       *    risk inside, merge after.
       */
      const landed = yield* merge({
        into: target,
        /**
         * **The merge commit's own message, and the second thing dogfooding found.**
         *
         * Git's default is `Merge branch 'kojo/<run id>'`, and a `commit-msg` hook runs on a merge
         * commit exactly as it runs on any other — so Cocogitto refused the *last step of the run*,
         * after the agent, the checks and the maintainer had all said yes, and git left the target
         * mid-merge for the phase to abort. `merge` gained a `message` for this, because the
         * convention is the repository's and no engine can know it.
         *
         * `feat(kojo):` whatever the lane, because what lands is one reviewed unit of work on this
         * repository and the lane's own type is already on the commits inside it.
         */
        message: conventional(
          "feat(kojo)",
          `merge the ${judged.lane} that ran as ${run.runId}\n\n${judged.summary}`,
        ),
        acceptance: new Acceptance({
          mechanical: judged.mechanical,
          human: fromVerdict(verdict),
        }),
      });

      /**
       * Ship: say what landed, read back off the target rather than assumed from what the run believed
       * it did.
       *
       * **Kojo publishes nothing yet, and this phase says so honestly instead of miming a release.**
       * When there is a registry version to cut, this body is the one line that changes — it is where
       * a `bun publish` or a tag goes. Until then it earns its place by *verifying* the merge: it
       * reads the target's own log, so a landing this run reported and git did not perform is a
       * failure here rather than a sentence in a success message.
       */
      const shipped = yield* code(
        {
          name: "ship",
          description: "Read back what landed, off the target branch itself",
          success: Schema.String,
          error: WorkspaceError,
        },
        Effect.gen(function* () {
          const workspace = yield* Workspace;
          const shown = yield* workspace.git(["show", "--no-patch", "--format=%h %s", landed.sha]);
          const files = yield* workspace.git([
            "diff",
            "--name-only",
            `${landed.sha}^1`,
            landed.sha,
          ]);
          const changed = files.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "");

          return [
            `${shown.stdout.trim()} is on ${landed.into}`,
            changed.length === 0
              ? "and it changed nothing, which a merge commit should never do"
              : `and it carries ${changed.length} file(s): ${changed.join(", ")}`,
          ].join(" ");
        }),
      );

      return [
        `${judged.lane}: ${judged.summary}`,
        "",
        `Routed there because ${routed.value.because}`,
        `Landed ${landed.branch} on ${landed.into} as ${landed.sha}.`,
        shipped,
      ].join("\n");
    }),
);
