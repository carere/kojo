import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { Verdict } from "../../../../../../src/contexts/gate/models/Verdict.ts";
import type { ScriptedCommand } from "../../../../../../src/contexts/sandbox/adapters/InMemoryWorkspace.ts";
import { WorkspaceError } from "../../../../../../src/contexts/sandbox/models/WorkspaceError.ts";
import { runBranch } from "../../../../../../src/contexts/shared/models/RunBranch.ts";
import type { RunId } from "../../../../../../src/contexts/shared/models/RunId.ts";
import * as InMemoryTracer from "../../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import {
  Acceptance,
  Judgement,
} from "../../../../../../src/contexts/workflow/models/Acceptance.ts";
import { Landing } from "../../../../../../src/contexts/workflow/models/Landing.ts";
import { MergeRefused } from "../../../../../../src/contexts/workflow/models/MergeRefused.ts";
import { NotAccepted } from "../../../../../../src/contexts/workflow/models/NotAccepted.ts";
import { fromVerdict } from "../../../../../../src/contexts/workflow/services/acceptance.ts";
import { merge } from "../../../../../../src/contexts/workflow/services/phase/merge.ts";
import { workflow } from "../../../../../../src/contexts/workflow/services/workflow.ts";
import * as observedWorkspace from "../../../../../support/observedWorkspace.ts";

const target = "main";

const suite = (passed: boolean) =>
  new Judgement({ by: "the suite", accepted: passed, reason: passed ? "24 passed" : "3 failed" });

const answered = (choice: string) =>
  fromVerdict(new Verdict({ choice, reason: "as I said", answerer: "kevin", answeredAt: 10 }));

/**
 * The lane, reduced to the only thing this file is about.
 *
 * The payload carries the two halves of the acceptance rather than a workflow that measures them,
 * because the conjunction is what the merge hangs on and the merge is what is under test. A whole
 * lane — a red suite, a real gate, a real branch — is the integration suite's job.
 */
const landing = workflow(
  {
    name: "landing",
    payload: { suite: Schema.Boolean, choice: Schema.String },
    success: Landing,
    error: Schema.Union([NotAccepted, MergeRefused, WorkspaceError]),
    idempotencyKey: (payload) => `landing/${payload.suite}/${payload.choice}`,
  },
  (payload) =>
    merge({
      into: target,
      acceptance: new Acceptance({
        mechanical: suite(payload.suite),
        human: answered(payload.choice),
      }),
    }),
);

/**
 * A merge message a Conventional Commits `commit-msg` hook accepts.
 *
 * Not decoration: git's own default is `Merge branch '<branch>'`, a `commit-msg` hook runs on a merge
 * commit exactly as it runs on any other, and `cog verify` reads that default as
 * `Missing commit type separator ':'`. Measured in Kojo's own repository — ticket 36 — where it
 * refused the last step of a run that everything else had already accepted.
 */
const convention = "feat(kojo): land the accepted branch";

/**
 * The same lane, with the merge commit's own message supplied by the author.
 *
 * A second definition rather than a field on the payload, because the point being graded is that the
 * *command* changes — and a payload-driven variant would grade a branch in this file instead.
 */
const written = workflow(
  {
    name: "landing-written",
    payload: { suite: Schema.Boolean, choice: Schema.String },
    success: Landing,
    error: Schema.Union([NotAccepted, MergeRefused, WorkspaceError]),
    idempotencyKey: (payload) => `landing-written/${payload.suite}/${payload.choice}`,
  },
  (payload) =>
    merge({
      into: target,
      message: convention,
      acceptance: new Acceptance({
        mechanical: suite(payload.suite),
        human: answered(payload.choice),
      }),
    }),
);

/** A target that is clean, on the right branch, and merges without complaint. */
const healthy = (branch: string): Record<string, ScriptedCommand> => ({
  "git rev-parse --abbrev-ref HEAD": { stdout: `${target}\n` },
  "git status --porcelain": { stdout: "" },
  [`git merge --no-ff --no-edit ${branch}`]: { stdout: "Merge made by the 'ort' strategy.\n" },
  "git rev-parse HEAD": { stdout: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\n" },
  "git merge --abort": {},
});

const runLanding = (
  commands: (branch: string) => Record<string, ScriptedCommand>,
  payload: { readonly suite: boolean; readonly choice: string },
) =>
  Effect.gen(function* () {
    const runId = (yield* landing.definition.executionId(payload)) as RunId;
    const branch = runBranch(runId);

    return yield* Effect.gen(function* () {
      const outcome = yield* Effect.result(landing.definition.execute(payload));
      const trace = yield* InMemoryTracer.RecordedTrace;
      return {
        branch,
        outcome,
        phases: yield* trace.phases,
        commands: yield* observedWorkspace.observed,
      };
    }).pipe(
      Effect.provide(
        landing.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              InMemoryTracer.layer,
              observedWorkspace.layer({ commands: commands(branch) }),
              WorkflowEngine.layerMemory,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(WorkflowEngine.layerMemory));

/** The same three commands, for the variant that carries the author's own merge message. */
const healthyWritten = (branch: string): Record<string, ScriptedCommand> => ({
  "git rev-parse --abbrev-ref HEAD": { stdout: `${target}\n` },
  "git status --porcelain": { stdout: "" },
  [`git merge --no-ff --no-edit --message ${convention} ${branch}`]: {
    stdout: "Merge made by the 'ort' strategy.\n",
  },
  "git rev-parse HEAD": { stdout: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\n" },
});

const runWritten = (payload: { readonly suite: boolean; readonly choice: string }) =>
  Effect.gen(function* () {
    const runId = (yield* written.definition.executionId(payload)) as RunId;
    const branch = runBranch(runId);

    return yield* Effect.gen(function* () {
      const outcome = yield* Effect.result(written.definition.execute(payload));
      return { branch, outcome, commands: yield* observedWorkspace.observed };
    }).pipe(
      Effect.provide(
        written.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              InMemoryTracer.layer,
              observedWorkspace.layer({ commands: healthyWritten(branch) }),
              WorkflowEngine.layerMemory,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(WorkflowEngine.layerMemory));

const accepted = { suite: true, choice: "approve" } as const;

describe("the merge an accepted run earns", () => {
  it.effect("lands the run's own branch on the target, and says which commit did it", () =>
    Effect.gen(function* () {
      const { branch, outcome, phases, commands } = yield* runLanding(healthy, accepted);

      expect(Result.isSuccess(outcome) && outcome.success).toEqual(
        new Landing({ branch, into: target, sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b" }),
      );

      // `--no-ff` so the run is a shape in the history rather than a set of commits that fast
      // forwarded into somebody else's work and vanished.
      expect(commands).toEqual([
        "git rev-parse --abbrev-ref HEAD",
        "git status --porcelain",
        `git merge --no-ff --no-edit ${branch}`,
        "git rev-parse HEAD",
      ]);

      // A code phase. An agent never runs the merge, and there is no shape of this API that lets one.
      expect(phases.map((phase) => `${phase.name}/${phase.kind}/${phase.outcome}`)).toEqual([
        "merge/code/succeeded",
      ]);
    }),
  );

  /**
   * **The merge commit's message is the author's when the author supplies one.**
   *
   * Absent, git writes `Merge branch '<branch>'` — and a `commit-msg` hook runs on a merge commit
   * exactly as it runs on any other, so a repository that enforces Conventional Commits refuses that
   * default at the very last step of a run. Kojo's own repository is one: ticket 36 watched `cog
   * verify` read git's default as `Missing commit type separator ':'`, git leave the target
   * mid-merge, and the phase abort and report `MergeRefused` after the agent, the checks and the
   * human had all said yes.
   *
   * `--no-edit` stays either way, because what keeps an unattended run out of an editor must not
   * depend on whether the author remembered a message.
   */
  it.effect("carries the author's own merge message into the git command", () =>
    Effect.gen(function* () {
      const { branch, outcome, commands } = yield* runWritten(accepted);

      expect(Result.isSuccess(outcome) && outcome.success).toEqual(
        new Landing({ branch, into: target, sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b" }),
      );
      expect(commands).toEqual([
        "git rev-parse --abbrev-ref HEAD",
        "git status --porcelain",
        `git merge --no-ff --no-edit --message ${convention} ${branch}`,
        "git rev-parse HEAD",
      ]);
    }),
  );
});

describe("a run that is not accepted", () => {
  /**
   * The claim the whole ticket rests on, and the reason the commands are observed at all.
   *
   * "It merged nothing" cannot be read off an error — a merge that ran and then failed produces one
   * too. What proves it is that git was never asked anything, and the workspace here is scripted to
   * answer every command a healthy merge needs, so a phase that reached even the first one would
   * pass rather than fail.
   */
  it.effect("runs no git at all when the suite was red, however the human answered", () =>
    Effect.gen(function* () {
      const { outcome, commands, phases } = yield* runLanding(healthy, {
        suite: false,
        choice: "approve",
      });

      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("NotAccepted");
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("the suite: 3 failed");
      expect(commands).toEqual([]);
      expect(phases.map((phase) => phase.outcome)).toEqual(["failed"]);
    }),
  );

  it.effect("runs no git at all when the human said no, however green the suite was", () =>
    Effect.gen(function* () {
      const { outcome, commands } = yield* runLanding(healthy, { suite: true, choice: "reject" });

      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("NotAccepted");
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("kevin: as I said");
      expect(commands).toEqual([]);
    }),
  );
});

describe("a merge that cannot land", () => {
  it.effect("refuses a target that is not the branch it was told to land on", () =>
    Effect.gen(function* () {
      const { outcome, commands } = yield* runLanding(
        (branch) => ({
          ...healthy(branch),
          "git rev-parse --abbrev-ref HEAD": { stdout: "spike\n" },
        }),
        accepted,
      );

      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("MergeRefused");
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe(
        "the workspace is on spike, and the merge targets main",
      );
      expect(commands).toEqual(["git rev-parse --abbrev-ref HEAD"]);
    }),
  );

  it.effect("refuses a target somebody is working in, rather than sweeping it into the merge", () =>
    Effect.gen(function* () {
      const { outcome, commands } = yield* runLanding(
        (branch) => ({
          ...healthy(branch),
          "git status --porcelain": { stdout: " M src/app.ts\n?? node_modules/\n" },
        }),
        accepted,
      );

      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("MergeRefused");
      // The reason names what is uncommitted. Ticket 47 walked into this refusal over a
      // `node_modules/` that `kojo init`'s own instructions had created, and a reason without the
      // paths sent the person off to run `git status` themselves.
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe(
        "main holds uncommitted changes: M src/app.ts, ?? node_modules/",
      );
      expect(commands).not.toContain("git merge --abort");
    }),
  );

  it.effect("caps the naming at five entries, and counts the rest", () =>
    Effect.gen(function* () {
      const files = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `?? ${name}.ts`);
      const { outcome } = yield* runLanding(
        (branch) => ({
          ...healthy(branch),
          "git status --porcelain": { stdout: `${files.join("\n")}\n` },
        }),
        accepted,
      );

      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe(
        "main holds uncommitted changes: ?? a.ts, ?? b.ts, ?? c.ts, ?? d.ts, ?? e.ts — and 2 more",
      );
    }),
  );

  /**
   * A conflict is the ordinary case, and it is the one that can leave a mess.
   *
   * git stops mid-merge with the index half-written, so the abort is what keeps "a rejected run
   * merges nothing and leaves everything intact" true for the target as well as for the branch.
   * Asserted through the commands, because the error alone cannot tell the two states apart.
   */
  it.effect("aborts a conflicted merge before it reports it", () =>
    Effect.gen(function* () {
      const { branch, outcome, commands } = yield* runLanding(
        (known) => ({
          ...healthy(known),
          [`git merge --no-ff --no-edit ${known}`]: {
            exitCode: 1,
            stdout: "CONFLICT (content): Merge conflict in src/app.ts\n",
          },
        }),
        accepted,
      );

      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("MergeRefused");
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe(
        "git merge exited 1: CONFLICT (content): Merge conflict in src/app.ts",
      );
      expect(commands).toEqual([
        "git rev-parse --abbrev-ref HEAD",
        "git status --porcelain",
        `git merge --no-ff --no-edit ${branch}`,
        "git merge --abort",
      ]);
    }),
  );
});
