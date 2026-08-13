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
import * as InMemoryClusterEngine from "../../../../../src/contexts/workflow/adapters/InMemoryClusterEngine.ts";
import { gate } from "../../../../../src/contexts/workflow/services/phase/gate.ts";
import { start, status } from "../../../../../src/contexts/workflow/services/run.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";
import { settleThenAdvance } from "../../../../support/settleThenAdvance.ts";

const reviewed = workflow(
  {
    name: "reviewed-on-cluster",
    payload: { subject: Schema.String },
    success: Verdict,
    error: Schema.Union([GateExpired, GateUnreachable]),
    idempotencyKey: (payload) => `reviewed-on-cluster/${payload.subject}`,
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
        InMemoryGate.layer(answers).pipe(Layer.provideMerge(InMemoryClusterEngine.layer)),
        // The gate phase now writes an expiry settlement where the queue reads, so every workflow
        // body consumes the repository beside the gate.
        InMemoryGateRepository.layer,
      ),
    ),
  );

/**
 * The cluster engine moves work by polling its own mailboxes, so settling is a clock step rather
 * than a yield. Everything here is virtual time — no test waits on anything real.
 */
const settle = settleThenAdvance(Duration.seconds(30));

const requested = Effect.flatMap(InMemoryGate.RequestedGates, (gates) => gates.requests);

describe("the cluster engine without SQL", () => {
  it.effect("carries a whole run through entity mailboxes", () =>
    Effect.gen(function* () {
      const runId = yield* start(reviewed.definition, { subject: "scripted" });
      yield* settle;

      expect(yield* status(reviewed.definition, runId)).toBe("succeeded");
    }).pipe(Effect.provide(layerFor({ review: [{ choice: "approve", reason: "now" }] }))),
  );

  it.effect("suspends at the gate and resumes on an answer written out of band", () =>
    Effect.gen(function* () {
      const runId = yield* start(reviewed.definition, { subject: "waiting" });
      yield* settle;

      expect(yield* status(reviewed.definition, runId)).toBe("suspended");

      const token = (yield* requested)[0]?.token as DurableDeferred.Token;
      yield* answerGate({ token, choice: "approve", reason: "reads fine", answerer: "kevin" });
      yield* settle;

      expect(yield* status(reviewed.definition, runId)).toBe("succeeded");
    }).pipe(Effect.provide(layerFor())),
  );
});
