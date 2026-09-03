import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { branchPrefix, runBranch } from "../../../../../src/contexts/shared/models/RunBranch.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";

describe("the branch a run owns", () => {
  it("is a function of the run id and of nothing else", () => {
    const runId = "9f86d081884c7d659a2feaa0c55ad015" as RunId;
    expect(runBranch(runId)).toBe(`${branchPrefix}9f86d081884c7d659a2feaa0c55ad015`);
    // Twice, because a resumed run derives the name again two days later rather than remembering it.
    expect(runBranch(runId)).toBe(runBranch(runId));
  });

  it("keeps every factory branch under one prefix, so a repository can be asked what Kojo owns", () => {
    const one = runBranch("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as RunId);
    const two = runBranch("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as RunId);
    expect(one.startsWith(branchPrefix)).toBe(true);
    expect(two.startsWith(branchPrefix)).toBe(true);
    expect(one).not.toBe(two);
  });

  /**
   * The claim the module's comment makes, measured rather than read.
   *
   * `runBranch` escapes nothing, and it is only allowed to because the engine's execution id is a
   * hex digest. If `Workflow.execute` ever minted something else, an idempotency key with a space or
   * a colon in it would reach git — so this pins the shape of a real run id, from a real engine,
   * against a payload written to be as hostile as an author's key can be.
   */
  it.effect("is a legal ref name for an id the engine really produced", () =>
    Effect.gen(function* () {
      const hostile = workflow(
        {
          name: "hostile",
          payload: { subject: Schema.String },
          success: Schema.String,
          error: Schema.Never,
          idempotencyKey: (payload) => `hostile ${payload.subject}: ~^:?*[\\`,
        },
        (payload) => Effect.succeed(payload.subject),
      );

      const runId = (yield* hostile.definition.executionId({ subject: "a b" })) as RunId;

      expect(runId).toMatch(/^[0-9a-f]{32}$/);
      expect(runBranch(runId)).toBe(`kojo/${runId}`);
      // The characters git refuses in a ref name, none of which survive the digest.
      expect(runBranch(runId)).toMatch(/^[A-Za-z0-9/_-]+$/);
    }).pipe(Effect.provide(WorkflowEngine.layerMemory)),
  );
});
