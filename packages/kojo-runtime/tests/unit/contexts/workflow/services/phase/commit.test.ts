import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import type { ScriptedCommand } from "../../../../../../src/contexts/sandbox/adapters/InMemoryWorkspace.ts";
import { WorkspaceError } from "../../../../../../src/contexts/sandbox/models/WorkspaceError.ts";
import { runBranch } from "../../../../../../src/contexts/shared/models/RunBranch.ts";
import type { RunId } from "../../../../../../src/contexts/shared/models/RunId.ts";
import * as InMemoryTracer from "../../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { Commit } from "../../../../../../src/contexts/workflow/models/Commit.ts";
import { CommitRefused } from "../../../../../../src/contexts/workflow/models/CommitRefused.ts";
import { commit } from "../../../../../../src/contexts/workflow/services/phase/commit.ts";
import { workflow } from "../../../../../../src/contexts/workflow/services/workflow.ts";
import { layer as inMemoryExecutionServices } from "../../../../../support/InMemoryExecutionServices.ts";
import {
  inMemoryWorkflowEngine,
  selfContainedTestLayer,
  serviceFreeWorkflowEffect,
} from "../../../../../support/inMemoryWorkflowEngine.ts";
import * as observedWorkspace from "../../../../../support/observedWorkspace.ts";

/** What the agent proposed. Code performs it; the agent never runs a git command. */
const message = "feat: teach the parser about trailing commas";

const author = { name: "Kojo", email: "kojo@example.invalid" } as const;

const committing = workflow(
  {
    name: "committing",
    payload: { subject: Schema.String },
    success: Commit,
    error: Schema.Union([CommitRefused, WorkspaceError]),
    idempotencyKey: (payload) => `committing/${payload.subject}`,
  },
  () =>
    commit({
      description: "Commit what the agent proposed, on the branch this run owns",
      message,
      author,
    }),
);

const committedAs = `git -c user.name=Kojo -c user.email=kojo@example.invalid commit --message ${message}`;

/** Everything a healthy commit needs to be told, given the branch the run turns out to own. */
const healthy = (branch: string): Record<string, ScriptedCommand> => ({
  "git rev-parse --abbrev-ref HEAD": { stdout: `${branch}\n` },
  "git add --all": {},
  "git diff --cached --name-only": { stdout: "src/parser.ts\nnotes/plan.md\n" },
  [committedAs]: {},
  "git rev-parse HEAD": { stdout: "9e1f0c4a3b2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f\n" },
});

/**
 * Runs the phase, having first asked the engine what run id this payload produces.
 *
 * The branch is not a fixture. It is derived from the real execution id, so the scripted `git
 * rev-parse` answers exactly what the phase is going to demand — and a change that made a commit
 * land anywhere but the run's own branch would fail here rather than agree with itself.
 */
const runCommitting = (
  commands: (branch: string) => Record<string, ScriptedCommand>,
  subject = "one",
) =>
  Effect.gen(function* () {
    const runId = (yield* committing.definition.executionId({ subject })) as RunId;
    const branch = runBranch(runId);

    return yield* Effect.gen(function* () {
      const outcome = yield* Effect.result(
        serviceFreeWorkflowEffect(committing.definition.execute({ subject })),
      );
      const trace = yield* InMemoryTracer.RecordedTrace;
      return {
        branch,
        outcome,
        phases: yield* trace.phases,
        commands: yield* observedWorkspace.observed,
      };
    }).pipe(
      Effect.provide(
        selfContainedTestLayer(
          committing.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                InMemoryTracer.layer,
                observedWorkspace.layer({ commands: commands(branch) }),
                inMemoryWorkflowEngine,
                inMemoryExecutionServices,
              ),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(inMemoryWorkflowEngine));

describe("agents propose, code disposes", () => {
  it.effect("performs the commit the agent asked for, on the branch the run owns", () =>
    Effect.gen(function* () {
      const { branch, outcome, phases, commands } = yield* runCommitting(healthy);

      expect(Result.isSuccess(outcome)).toBe(true);
      expect(Result.isSuccess(outcome) && outcome.success).toEqual(
        new Commit({
          branch,
          sha: "9e1f0c4a3b2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f",
          message,
          // Read from the index, not from the envelope: what git staged is a fact, and what the
          // agent claimed it changed is a claim that `diffMatchesClaims` grades separately.
          files: ["src/parser.ts", "notes/plan.md"],
        }),
      );

      // A code phase, and one row for it. Nothing here is an agent.
      expect(phases.map((phase) => `${phase.name}/${phase.kind}/${phase.outcome}`)).toEqual([
        "commit/code/succeeded",
      ]);

      // The commands themselves, pinned. The identity is passed with `-c` rather than written into
      // the repository's config, so a bare worktree can commit and nothing is left behind.
      expect(commands).toEqual([
        "git rev-parse --abbrev-ref HEAD",
        "git add --all",
        "git diff --cached --name-only",
        committedAs,
        "git rev-parse HEAD",
      ]);
    }),
  );

  it.effect("refuses to commit anywhere but the branch the run owns, and runs nothing else", () =>
    Effect.gen(function* () {
      const { branch, outcome, commands, phases } = yield* runCommitting((known) => ({
        ...healthy(known),
        "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      }));

      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("CommitRefused");
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe(
        `the workspace is on main, and this run owns ${branch}`,
      );

      // The evidence that it merged nothing into somebody else's branch: it asked one question and
      // stopped. `git add --all` on a shared checkout is not a mistake anyone recovers from quickly.
      expect(commands).toEqual(["git rev-parse --abbrev-ref HEAD"]);
      expect(phases.map((phase) => phase.outcome)).toEqual(["failed"]);
      // Pinned as it is today, not as it should be: `code` writes no `errorTag`, so the refusal's
      // tag reaches the run's recorded exit and not the phase row. Widening that row belongs to the
      // trace schema (ticket 24), and this assertion is here to fail loudly when it lands.
      expect(phases[0]?.errorTag).toBe(undefined);
    }),
  );

  it.effect("refuses an empty commit rather than writing a message about nothing", () =>
    Effect.gen(function* () {
      const { outcome, commands } = yield* runCommitting((branch) => ({
        ...healthy(branch),
        "git diff --cached --name-only": { stdout: "\n" },
      }));

      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("CommitRefused");
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe(
        "the working tree holds no change to commit",
      );
      expect(commands).not.toContain(committedAs);
    }),
  );

  it.effect("hands git's own complaint back when the commit itself fails", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCommitting((branch) => ({
        ...healthy(branch),
        [committedAs]: { exitCode: 128, stderr: "Author identity unknown\n" },
      }));

      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("CommitRefused");
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe(
        "git commit exited 128: Author identity unknown",
      );
    }),
  );

  /**
   * A workspace that could not run git at all is not a refusal.
   *
   * `CommitRefused` means git answered and the answer was no. A spawn that never happened is a
   * `WorkspaceError`, and collapsing the two would let a broken container read as a run with
   * nothing to commit.
   */
  it.effect("keeps a workspace failure in its own channel", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runCommitting(() => ({}));
      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("WorkspaceError");
    }),
  );
});
