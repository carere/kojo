import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makePhaseId } from "../../../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { RecordedTrace } from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import * as RecordingTracer from "../../../../../src/contexts/trace/adapters/RecordingTracer.ts";
import { InFlightPhase } from "../../../../../src/contexts/trace/models/InFlightPhase.ts";
import { PhaseRecord } from "../../../../../src/contexts/trace/models/PhaseRecord.ts";
import { RunRecord } from "../../../../../src/contexts/trace/models/RunRecord.ts";
import { Tracer } from "../../../../../src/contexts/trace/ports/Tracer.ts";

/**
 * The decorator the CLI writes its trace through: one record, two destinations.
 *
 * The destination that matters in a factory is a database, and this tier does not have one — so the
 * tracer underneath is a plain array here, and what is graded is the fan-out itself. Every record a
 * command hands the trace must reach **both** the durable writer and the copy `kojo run` prints,
 * because dropping either one is invisible: a lost durable write is an empty Console, and a lost
 * copy is an empty phase table.
 */

const runId = "run-decorated" as RunId;

const record = new RunRecord({
  runId,
  workflow: "lane",
  idempotencyKey: "lane/one",
  startedAt: 1_000,
  engineVersion: "0.0.0",
  engineCommit: "development",
  configDigest: "sha256:abc",
  host: "builder-1",
});

const drafted = new PhaseRecord({
  runId,
  phaseId: makePhaseId(runId, "draft", 1),
  name: "draft",
  description: "the draft phase",
  kind: "code",
  outcome: "succeeded",
  attempt: 1,
  startedAt: 1_000,
  endedAt: 2_000,
});

const entered = new InFlightPhase({
  phaseId: makePhaseId(runId, "draft", 1),
  name: "draft",
  kind: "code",
  attempt: 1,
  startedAt: 1_000,
});

/** What the durable writer would be, reduced to the only question asked of it: was it told? */
const underneath = () => {
  const told: Array<string> = [];
  const layer = Layer.succeed(Tracer, {
    runStarted: (given: RunRecord) => Effect.sync(() => void told.push(`run ${given.runId}`)),
    runFinished: (given: RunId, outcome: string) =>
      Effect.sync(() => void told.push(`end ${given} ${outcome}`)),
    phaseEntered: (given: RunId, phase: InFlightPhase) =>
      Effect.sync(() => void told.push(`entered ${given} ${phase.name}`)),
    phase: (given: PhaseRecord) => Effect.sync(() => void told.push(`phase ${given.name}`)),
    gate: () => Effect.void,
    sandbox: () => Effect.void,
    occurrence: () => Effect.void,
  });
  return { told, layer };
};

describe("the recording tracer", () => {
  it.effect("hands every record to the tracer underneath and keeps a copy of it", () =>
    Effect.gen(function* () {
      const durable = underneath();

      const kept = yield* Effect.gen(function* () {
        const tracer = yield* Tracer;
        yield* tracer.runStarted(record);
        yield* tracer.phase(drafted);
        yield* tracer.runFinished(runId, "suspended");

        const recorded = yield* RecordedTrace;
        return {
          runs: (yield* recorded.runs).map((entry) => entry.runId),
          phases: (yield* recorded.phases).map((entry) => entry.name),
          outcomes: [...(yield* recorded.outcomes).entries()],
        };
      }).pipe(Effect.provide(RecordingTracer.layer.pipe(Layer.provide(durable.layer))));

      // The durable half: it was told all three, in order, and none of them stopped at the copy.
      expect(durable.told).toEqual([`run ${runId}`, "phase draft", `end ${runId} suspended`]);

      // The in-process half: the same three, readable back as `kojo run` reads them.
      expect(kept.runs).toEqual([runId]);
      expect(kept.phases).toEqual(["draft"]);
      expect(kept.outcomes).toEqual([[runId, "suspended"]]);
    }),
  );

  it.effect("passes the in-flight phase through and drops it when the record arrives", () =>
    Effect.gen(function* () {
      const durable = underneath();

      const seen = yield* Effect.gen(function* () {
        const tracer = yield* Tracer;
        const recorded = yield* RecordedTrace;

        yield* tracer.phaseEntered(runId, entered);
        const running = [...(yield* recorded.inFlight).entries()].map(
          ([id, phase]) => `${id} ${phase.name}`,
        );

        // The record replaces the status. Nothing else clears it, and nothing else may: a run that
        // kept claiming to be inside a phase whose record exists would draw the phase twice.
        yield* tracer.phase(drafted);
        const after = [...(yield* recorded.inFlight).keys()];

        return { running, after };
      }).pipe(Effect.provide(RecordingTracer.layer.pipe(Layer.provide(durable.layer))));

      expect(durable.told).toEqual([`entered ${runId} draft`, "phase draft"]);
      expect(seen.running).toEqual([`${runId} draft`]);
      expect(seen.after).toEqual([]);
    }),
  );
});
