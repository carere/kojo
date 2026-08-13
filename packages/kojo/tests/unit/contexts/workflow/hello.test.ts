import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { hello } from "../../../../src/cli/hello.ts";
import * as InMemoryTracer from "../../../../src/contexts/trace/adapters/InMemoryTracer.ts";

// Unit tier: in-memory adapters only, and the in-memory engine. Nothing here reads a wall clock
// or spawns anything.
const TestLayer = hello.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(InMemoryTracer.layer, WorkflowEngine.layerMemory)),
);

const runHello = (payload: { who: string; fail: boolean }) =>
  Effect.gen(function* () {
    const outcome = yield* hello.definition.execute(payload).pipe(Effect.result);
    const trace = yield* InMemoryTracer.RecordedTrace;
    return {
      outcome,
      phases: yield* trace.phases,
      runs: yield* trace.runs,
      outcomes: yield* trace.outcomes,
    };
  }).pipe(Effect.provide(TestLayer));

describe("the hello workflow", () => {
  it.effect("records its phases in the order they ran", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runHello({ who: "Kevin", fail: false });

      expect(Result.isSuccess(outcome)).toBe(true);
      expect(phases.map((phase) => phase.name)).toEqual(["compose", "deliver"]);
      expect(phases.map((phase) => phase.outcome)).toEqual(["succeeded", "succeeded"]);
      expect(phases.every((phase) => phase.kind === "code")).toBe(true);
      expect(phases.every((phase) => phase.attempt === 1)).toBe(true);
    }),
  );

  it.effect("leaves a complete record for a phase that failed", () =>
    Effect.gen(function* () {
      const { outcome, phases } = yield* runHello({ who: "Kevin", fail: true });

      expect(Result.isFailure(outcome)).toBe(true);

      // The point of the wide record: the failing phase is still there, in order, with everything
      // known about it. A phase with no record is a phase nobody can debug.
      expect(phases.map((phase) => phase.name)).toEqual(["compose", "deliver"]);
      const failed = phases[1];
      expect(failed?.outcome).toBe("failed");
      expect(failed?.description).toBeTruthy();
      // `Activity.CurrentAttempt` counts from 1, not 0. A record showing attempt 1 is a phase
      // that ran once, not one that was already retried.
      expect(failed?.attempt).toBe(1);
      expect(failed?.endedAt).toBeGreaterThanOrEqual(failed?.startedAt ?? 0);
    }),
  );

  it.effect("writes exactly one record per phase", () =>
    Effect.gen(function* () {
      const { phases } = yield* runHello({ who: "Kevin", fail: false });
      expect(phases).toHaveLength(new Set(phases.map((phase) => phase.phaseId)).size);
    }),
  );

  it.effect("stamps the run with what produced it", () =>
    Effect.gen(function* () {
      const { runs, outcomes } = yield* runHello({ who: "Kevin", fail: false });

      expect(runs).toHaveLength(1);
      const run = runs[0];
      expect(run?.workflow).toBe("demo-hello");
      expect(run?.engineVersion).toBeTruthy();
      expect(run?.engineCommit).toBeTruthy();
      expect(outcomes.get(run?.runId ?? ("" as never))).toBe("succeeded");
    }),
  );
});
