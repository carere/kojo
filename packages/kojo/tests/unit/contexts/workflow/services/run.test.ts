import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Schema } from "effect";
import type { DurableDeferred } from "effect/unstable/workflow";
import * as InMemoryGate from "../../../../../src/contexts/gate/adapters/InMemoryGate.ts";
import * as InMemoryGateRepository from "../../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import { GateExpired } from "../../../../../src/contexts/gate/models/GateExpired.ts";
import { GateUnreachable } from "../../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../../src/contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../../../../../src/contexts/gate/models/Verdict.ts";
import { answerGate } from "../../../../../src/contexts/gate/services/answerGate.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import * as InMemoryEngine from "../../../../../src/contexts/workflow/adapters/InMemoryEngine.ts";
import { gate } from "../../../../../src/contexts/workflow/services/phase/gate.ts";
import { start, status } from "../../../../../src/contexts/workflow/services/run.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";
import { settle, settleThenAdvance } from "../../../../support/settleThenAdvance.ts";

/** A run that stops at one human decision, and fails when the decision never arrives. */
const reviewed = workflow(
  {
    name: "reviewed",
    payload: { subject: Schema.String },
    success: Verdict,
    error: Schema.Union([GateExpired, GateUnreachable]),
    idempotencyKey: (payload) => `reviewed/${payload.subject}`,
  },
  () =>
    gate({
      name: "review",
      description: "Does this land on main?",
      actor: "engineer",
      choices: ["approve", "reject"],
      deadline: Duration.days(7),
      onExpiry: OnExpiry.fail(),
      asking: 1,
    }),
);

const layerFor = (answers: Record<string, ReadonlyArray<InMemoryGate.ProgrammedAnswer>> = {}) =>
  reviewed.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InMemoryTracer.layer,
        InMemoryGate.layer(answers).pipe(Layer.provideMerge(InMemoryEngine.layer)),
        // The gate phase now writes an expiry settlement where the queue reads, so every workflow
        // body consumes the repository beside the gate.
        InMemoryGateRepository.layer,
      ),
    ),
  );

const requested = Effect.flatMap(InMemoryGate.RequestedGates, (gates) => gates.requests);

describe("starting a run", () => {
  it.effect("returns the run id while the run is still waiting on a human", () =>
    Effect.gen(function* () {
      // The assertion is that this line settles at all. A bare `execute` is a poll loop that only
      // returns on `Complete`, so on a run that suspends for seven days it returns in seven days.
      const runId = yield* start(reviewed.definition, { subject: "one" });
      yield* settle;

      expect(runId).toBe(yield* reviewed.definition.executionId({ subject: "one" }));
      expect(yield* status(reviewed.definition, runId)).toBe("suspended");
      expect(yield* requested).toHaveLength(1);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("reports the run as succeeded once the answer arrives", () =>
    Effect.gen(function* () {
      const runId = yield* start(reviewed.definition, { subject: "two" });
      yield* settle;

      const token = (yield* requested)[0]?.token as DurableDeferred.Token;
      yield* settleThenAdvance(Duration.days(2));
      yield* answerGate({ token, choice: "approve", reason: "reads fine", answerer: "kevin" });
      yield* settle;

      expect(yield* status(reviewed.definition, runId)).toBe("succeeded");
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("reports the run as failed when nobody answers in time", () =>
    Effect.gen(function* () {
      const runId = yield* start(reviewed.definition, { subject: "three" });
      yield* settle;

      yield* settleThenAdvance(Duration.days(8));

      expect(yield* status(reviewed.definition, runId)).toBe("failed");
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("reports a run the engine has no result for as running", () =>
    Effect.gen(function* () {
      // Nothing was started under this id, which is the same shape the engine reports for a run
      // that is executing right now: no recorded result yet.
      expect(yield* status(reviewed.definition, "reviewed/never-started" as never)).toBe("running");
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("runs a scripted gate straight through to a verdict", () =>
    Effect.gen(function* () {
      const runId = yield* start(reviewed.definition, { subject: "four" });
      yield* settle;

      expect(yield* status(reviewed.definition, runId)).toBe("succeeded");
    }).pipe(Effect.provide(layerFor({ review: [{ choice: "approve", reason: "now" }] }))),
  );
});
