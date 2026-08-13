import { describe, expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { type DurableDeferred, type Workflow, WorkflowEngine } from "effect/unstable/workflow";
import * as InMemoryGateRepository from "../../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import * as RecordingGate from "../../../../../src/contexts/gate/adapters/RecordingGate.ts";
import { GateExpired } from "../../../../../src/contexts/gate/models/GateExpired.ts";
import { GateStoreError } from "../../../../../src/contexts/gate/models/GateStoreError.ts";
import { GateUnreachable } from "../../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../../src/contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../../../../../src/contexts/gate/models/Verdict.ts";
import { GateRepository } from "../../../../../src/contexts/gate/ports/GateRepository.ts";
import { answerGate } from "../../../../../src/contexts/gate/services/answerGate.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { gate } from "../../../../../src/contexts/workflow/services/phase/gate.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";
import { settle } from "../../../../support/settleThenAdvance.ts";

/**
 * Two gates in a row, so answering the first makes the engine replay the whole body over the second.
 *
 * That replay is the subject. The asking is written from inside the request activity, so a body
 * that runs three times must still leave one row per *asking* — two — rather than one per pass.
 */
const twice = workflow(
  {
    name: "twice",
    payload: { subject: Schema.String },
    success: Schema.Array(Verdict),
    error: Schema.Union([GateExpired, GateUnreachable]),
    idempotencyKey: (payload) => `twice/${payload.subject}`,
  },
  () =>
    Effect.gen(function* () {
      const asking = (name: string) => ({
        name,
        description: `does ${name} land?`,
        actor: "engineer",
        choices: ["approve", "reject"],
        deadline: Duration.days(7),
        onExpiry: OnExpiry.fail(),
        asking: 1,
      });

      const first = yield* gate(asking("first"));
      const second = yield* gate(asking("second"));
      return [first, second];
    }),
);

const layerFor = (repository: Layer.Layer<GateRepository>) =>
  twice.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InMemoryTracer.layer,
        WorkflowEngine.layerMemory,
        RecordingGate.layer.pipe(Layer.provideMerge(repository)),
      ),
    ),
  );

/** A store that cannot be written to. The point is what the *run* does about it. */
const brokenRepository = Layer.succeed(GateRepository, {
  asked: () =>
    Effect.fail(new GateStoreError({ operation: "ask", reason: "disk is full", cause: undefined })),
  recorded: () => Effect.succeed(false),
  expired: () => Effect.succeed(false),
  byToken: () => Effect.succeed(Option.none()),
  all: Effect.succeed([]),
});

const asked = Effect.flatMap(GateRepository, (repository) => repository.all);

const start = (subject: string) =>
  Effect.gen(function* () {
    const executionId = yield* twice.definition.execute({ subject }, { discard: true });
    yield* settle;
    return executionId;
  });

describe("the recording gate", () => {
  it.effect("writes the asking down, so something other than a terminal can find it", () =>
    Effect.gen(function* () {
      const executionId = yield* start("one");
      const askings = yield* asked;

      expect(askings).toHaveLength(1);
      expect(askings[0]?.request.gate).toBe("first");
      expect(askings[0]?.request.actor).toBe("engineer");
      expect(askings[0]?.request.runId).toBe(executionId);
      // Nobody has answered, so there is no verdict — and that absence is the whole list's subject.
      expect(askings[0]?.verdict).toBeUndefined();
      expect(askings[0]?.state(askings[0].request.requestedAt)).toBe("waiting");
    }).pipe(Effect.provide(layerFor(InMemoryGateRepository.layer))),
  );

  it.effect("leaves one row per asking, however many times the body replays", () =>
    Effect.gen(function* () {
      const executionId = yield* start("two");
      const first = (yield* asked)[0]?.request.token;

      yield* answerGate({
        token: first as DurableDeferred.Token,
        choice: "approve",
        reason: "reads fine",
        answerer: "kevin",
      });
      yield* settle;

      // The body has now executed twice: once to the first gate, once from the top to the second.
      // A write placed *around* the request activity rather than inside it would leave three rows
      // here — the first asking written again on the replay — which is exactly the class of defect
      // the durability suite exists to catch.
      const askings = yield* asked;
      expect(askings.map((asking) => asking.request.gate)).toEqual(["first", "second"]);
      expect(askings.every((asking) => asking.request.runId === executionId)).toBe(true);
    }).pipe(Effect.provide(layerFor(InMemoryGateRepository.layer))),
  );

  it.effect("keeps the first verdict, because the engine keeps the first verdict", () =>
    Effect.gen(function* () {
      yield* start("three");
      const repository = yield* GateRepository;
      const token = (yield* asked)[0]?.request.token as DurableDeferred.Token;
      const verdict = (choice: string, answerer: string) =>
        new Verdict({ choice, reason: "", answerer, answeredAt: 0 });

      expect(yield* repository.recorded({ token, verdict: verdict("approve", "kevin") })).toBe(
        true,
      );
      // `DurableDeferred.succeed` refuses to overwrite a recorded result, so this second answer
      // changes nothing about the run. A list that showed `reject by dana` would be reporting a
      // decision the run never took.
      expect(yield* repository.recorded({ token, verdict: verdict("reject", "dana") })).toBe(false);

      const kept = yield* repository.byToken(token);
      expect(Option.getOrUndefined(kept)?.verdict?.answerer).toBe("kevin");
      expect(Option.getOrUndefined(kept)?.verdict?.choice).toBe("approve");
    }).pipe(Effect.provide(layerFor(InMemoryGateRepository.layer))),
  );

  it.effect("fails the ask when the asking cannot be written down", () =>
    Effect.gen(function* () {
      const executionId = yield* twice.definition.execute({ subject: "broken" }, { discard: true });
      yield* settle;

      // An asking nobody can list is an asking nobody will answer, and a run that suspended on one
      // would wait out its whole deadline for nothing. `GateUnreachable` is exactly that: the
      // requesting half never got out.
      const polled = yield* twice.definition.poll(executionId);
      const result = Option.getOrThrow(polled);
      expect(result._tag).toBe("Complete");

      const exit = (result as Workflow.Complete<ReadonlyArray<Verdict>, GateUnreachable>).exit;
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(failure?._tag).toBe("GateUnreachable");
      expect(failure?.reason).toContain("disk is full");
    }).pipe(Effect.provide(layerFor(brokenRepository))),
  );
});
