import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { type DurableDeferred, type Workflow, WorkflowEngine } from "effect/unstable/workflow";
import * as InMemoryGate from "../../../../src/contexts/gate/adapters/InMemoryGate.ts";
import * as InMemoryGateRepository from "../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import * as RecordingGate from "../../../../src/contexts/gate/adapters/RecordingGate.ts";
import { unsettled } from "../../../../src/contexts/gate/models/AskedGate.ts";
import { GateExpired } from "../../../../src/contexts/gate/models/GateExpired.ts";
import { GateUnreachable } from "../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../src/contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../../../../src/contexts/gate/models/Verdict.ts";
import { GateRepository } from "../../../../src/contexts/gate/ports/GateRepository.ts";
import { answerGate, parseToken } from "../../../../src/contexts/gate/services/answerGate.ts";
import * as InMemoryTracer from "../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { gate } from "../../../../src/contexts/workflow/services/phase/gate.ts";
import { workflow } from "../../../../src/contexts/workflow/services/workflow.ts";
import { settle, settleThenAdvance } from "../../../support/settleThenAdvance.ts";

const deadline = Duration.days(7);

/** The gate every test here asks, minus the two things each test varies. */
const review = (options: { readonly asking: number; readonly onExpiry: OnExpiry.OnExpiry }) => ({
  name: "review",
  description: "Does this land on main?",
  actor: "engineer",
  choices: ["approve", "reject"] as const,
  deadline,
  onExpiry: options.onExpiry,
  asking: options.asking,
});

/**
 * Two askings of one gate, whose deferred names the payload controls.
 *
 * `askings: [1, 1]` is the naive loop the design warns about; `[1, 2]` is the correct one. Same
 * workflow, one number apart, so the tests below compare exactly the thing that matters.
 */
const asked = workflow(
  {
    name: "asked",
    payload: {
      subject: Schema.String,
      askings: Schema.Array(Schema.Finite),
      onExpiry: Schema.Literals(["fail", "reject", "escalate"]),
    },
    success: Schema.Array(Verdict),
    error: Schema.Union([GateExpired, GateUnreachable]),
    idempotencyKey: (payload) => `asked/${payload.subject}`,
  },
  (payload) =>
    Effect.gen(function* () {
      const onExpiry =
        payload.onExpiry === "fail"
          ? OnExpiry.fail()
          : payload.onExpiry === "reject"
            ? OnExpiry.reject({ choice: "reject", reason: "nobody answered in time" })
            : OnExpiry.escalate({ to: "lead", deadline: Duration.days(1) });

      const verdicts: Array<Verdict> = [];
      for (const asking of payload.askings) {
        verdicts.push(yield* gate(review({ asking, onExpiry })));
      }
      return verdicts;
    }),
);

/** Stands in for a sandbox: acquired around the gate, and expected to be gone while it waits. */
const holds: Array<string> = [];

const held = workflow(
  {
    name: "held",
    payload: { subject: Schema.String },
    success: Verdict,
    error: Schema.Union([GateExpired, GateUnreachable]),
    idempotencyKey: (payload) => `held/${payload.subject}`,
  },
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => holds.push("acquired")),
          () => Effect.sync(() => void holds.push("released")),
        );
        return yield* gate(review({ asking: 1, onExpiry: OnExpiry.fail() }));
      }),
    ),
);

const layerFor = (answers: Record<string, ReadonlyArray<InMemoryGate.ProgrammedAnswer>> = {}) =>
  Layer.mergeAll(asked.layer, held.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InMemoryTracer.layer,
        InMemoryGate.layer(answers).pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
        // The gate phase now writes an expiry settlement where the queue reads, so every workflow
        // body consumes the repository beside the gate.
        InMemoryGateRepository.layer,
      ),
    ),
  );

/**
 * `execute` does not return while a run is suspended — the engine's execute is a poll loop that
 * only returns on `Complete` — so every test here starts with `discard: true` and asks `poll`.
 * Time moves through `settleThenAdvance`, never through a bare `TestClock.adjust`.
 */

const statusOf = (executionId: string) =>
  Effect.map(asked.definition.poll(executionId), (polled) =>
    Option.match(polled, {
      onNone: () => "running" as const,
      onSome: (result) => result._tag,
    }),
  );

const start = (payload: {
  readonly subject: string;
  readonly askings: ReadonlyArray<number>;
  readonly onExpiry?: "fail" | "reject" | "escalate";
}) =>
  Effect.gen(function* () {
    const executionId = yield* asked.definition.execute(
      { ...payload, onExpiry: payload.onExpiry ?? "fail" },
      { discard: true },
    );
    yield* settle;
    return executionId;
  });

const requested = Effect.flatMap(InMemoryGate.RequestedGates, (gates) => gates.requests);

const answer = (token: DurableDeferred.Token, choice: string, reason: string) =>
  Effect.gen(function* () {
    yield* answerGate({ token, choice, reason, answerer: "kevin" });
    yield* settle;
  });

describe("asking a human", () => {
  it.effect("returns a token and suspends, holding nothing", () =>
    Effect.gen(function* () {
      const executionId = yield* start({ subject: "one", askings: [1] });

      expect(yield* statusOf(executionId)).toBe("Suspended");

      const requests = yield* requested;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.actor).toBe("engineer");
      expect(requests[0]?.deadlineAt).toBe(
        (requests[0]?.requestedAt ?? 0) + Duration.toMillis(deadline),
      );

      // The token is the whole handover: it decodes to the run that is waiting and to the name of
      // this exact asking, which is what lets another process answer it.
      const parsed = yield* parseToken(requests[0]?.token ?? "");
      expect(parsed.executionId).toBe(executionId);
      expect(parsed.deferredName).toBe("gate/review/1");
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("releases what the run was holding, before the human even reads the question", () =>
    Effect.gen(function* () {
      const executionId = yield* held.definition.execute({ subject: "scope" }, { discard: true });
      yield* settle;

      expect(Option.map(yield* held.definition.poll(executionId), (r) => r._tag)).toEqual(
        Option.some("Suspended"),
      );
      // Suspension is an ordinary interrupt, so the scope unwinds where it stands. A sandbox held
      // across a two-day gate is a container nobody is using and a lock nobody can take.
      expect(holds).toEqual(["acquired", "released"]);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("continues on an answer given later, and records the human latency", () =>
    Effect.gen(function* () {
      const executionId = yield* start({ subject: "two", askings: [1] });
      const requests = yield* requested;
      const token = requests[0]?.token;

      // Two days pass with the run holding nothing at all.
      yield* settleThenAdvance(Duration.days(2));
      yield* answer(token as DurableDeferred.Token, "approve", "reads fine");

      const polled = yield* asked.definition.poll(executionId);
      const result = Option.getOrThrow(polled);
      expect(result._tag).toBe("Complete");
      const exit = (result as Workflow.Complete<ReadonlyArray<Verdict>, never>).exit;
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(Exit.isSuccess(exit) && exit.value[0]?.choice).toBe("approve");

      const gates = yield* Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.gates);
      expect(gates).toHaveLength(1);
      expect(gates[0]?.outcome).toBe("answered");
      expect(gates[0]?.actor).toBe("engineer");
      expect(gates[0]?.answerer).toBe("kevin");
      expect(gates[0]?.reason).toBe("reads fine");
      expect(gates[0]?.latencyMillis).toEqual(Option.some(Duration.toMillis(Duration.days(2))));
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("asking the same human twice", () => {
  // This is the defect the per-asking name exists to prevent, written down as a test so it cannot
  // come back. A `DurableDeferred` is keyed `executionId/name` and refuses to overwrite, so a loop
  // that re-asks under one name reads the first verdict back instantly and forever.
  it.effect("under one name, replays the first verdict without ever asking again", () =>
    Effect.gen(function* () {
      const executionId = yield* start({ subject: "fixed", askings: [1, 1] });
      expect(yield* statusOf(executionId)).toBe("Suspended");

      const token = (yield* requested)[0]?.token;
      yield* answer(token as DurableDeferred.Token, "reject", "needs work");

      // One human, asked once, and the run believes it asked twice.
      expect(yield* statusOf(executionId)).toBe("Complete");
      expect(yield* requested).toHaveLength(1);

      const gates = yield* Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.gates);
      expect(gates).toHaveLength(1);
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("under a name per asking, suspends again and asks again", () =>
    Effect.gen(function* () {
      const executionId = yield* start({ subject: "distinct", askings: [1, 2] });
      expect(yield* statusOf(executionId)).toBe("Suspended");
      expect(yield* requested).toHaveLength(1);

      yield* answer((yield* requested)[0]?.token as DurableDeferred.Token, "reject", "needs work");

      // The second asking is a genuine suspension: a new token, and nobody has answered it.
      expect(yield* statusOf(executionId)).toBe("Suspended");
      const requests = yield* requested;
      expect(requests).toHaveLength(2);
      expect(requests[1]?.token).not.toBe(requests[0]?.token);

      yield* answer(requests[1]?.token as DurableDeferred.Token, "approve", "better");

      expect(yield* statusOf(executionId)).toBe("Complete");
      const gates = yield* Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.gates);
      expect(gates.map((record) => record.asking)).toEqual(["gate/review/1", "gate/review/2"]);
      expect(gates.map((record) => record.choice)).toEqual(["reject", "approve"]);
    }).pipe(Effect.provide(layerFor())),
  );
});

describe("nobody answers in time", () => {
  it.effect("fails the run when the declared branch is fail", () =>
    Effect.gen(function* () {
      const executionId = yield* start({ subject: "fail", askings: [1], onExpiry: "fail" });
      expect(yield* statusOf(executionId)).toBe("Suspended");

      yield* settleThenAdvance(Duration.days(8));

      const result = Option.getOrThrow(yield* asked.definition.poll(executionId));
      const exit = (result as Workflow.Complete<ReadonlyArray<Verdict>, GateExpired>).exit;
      expect(Exit.isFailure(exit)).toBe(true);

      const gates = yield* Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.gates);
      expect(gates[0]?.outcome).toBe("expired");
      expect(gates[0]?.answerer).toBeUndefined();
      expect(gates[0]?.latencyMillis).toEqual(Option.none());
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("answers on the human's behalf when the declared branch is reject", () =>
    Effect.gen(function* () {
      const executionId = yield* start({ subject: "auto", askings: [1], onExpiry: "reject" });
      yield* settleThenAdvance(Duration.days(8));

      const result = Option.getOrThrow(yield* asked.definition.poll(executionId));
      const exit = (result as Workflow.Complete<ReadonlyArray<Verdict>, never>).exit;
      expect(Exit.isSuccess(exit) && exit.value[0]?.choice).toBe("reject");
      // The auto-reject must not claim a person answered it.
      expect(Exit.isSuccess(exit) && exit.value[0]?.answerer).toBe("kojo");
    }).pipe(Effect.provide(layerFor())),
  );

  it.effect("asks somebody else once when the declared branch is escalate", () =>
    Effect.gen(function* () {
      const executionId = yield* start({ subject: "up", askings: [1], onExpiry: "escalate" });
      // Exactly the first deadline, not past it: advancing further in one step would also carry
      // the escalated asking past *its* own deadline inside the same adjustment.
      yield* settleThenAdvance(deadline);

      const requests = yield* requested;
      expect(requests).toHaveLength(2);
      expect(requests[1]?.actor).toBe("lead");
      expect(yield* statusOf(executionId)).toBe("Suspended");

      yield* answer(requests[1]?.token as DurableDeferred.Token, "approve", "I'll take it");
      expect(yield* statusOf(executionId)).toBe("Complete");
    }).pipe(Effect.provide(layerFor())),
  );
});

/**
 * The same workflows over the reference gate — `RecordingGate` over the in-memory repository — so
 * the rows a run leaves behind are readable. `InMemoryGate` above keeps nothing on purpose, which
 * is exactly what these tests cannot use: they are about what the queue's read model holds.
 */
const settlingLayer = Layer.mergeAll(asked.layer, held.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      InMemoryTracer.layer,
      WorkflowEngine.layerMemory,
      RecordingGate.layer.pipe(Layer.provideMerge(InMemoryGateRepository.layer)),
    ),
  ),
);

const askingsOnFile = Effect.flatMap(GateRepository, (repository) => repository.all);

describe("an expired asking settles in the queue's read model", () => {
  // Ticket 46's failure, written down: an expiry writes no verdict, so before the settlement was
  // recorded the asking sat in *waiting* forever, *overdue by* a number growing without bound.
  it.effect("leaves the waiting list when the declared branch is fail", () =>
    Effect.gen(function* () {
      yield* start({ subject: "settled-fail", askings: [1], onExpiry: "fail" });

      // While the run waits, the asking is genuinely on somebody's desk.
      expect(unsettled(yield* askingsOnFile)).toHaveLength(1);

      yield* settleThenAdvance(Duration.days(8));

      const askings = yield* askingsOnFile;
      expect(askings).toHaveLength(1);
      // Settled at the deadline — the moment the asking stopped being answerable — and therefore
      // out of the waiting list, while the row itself stays readable.
      expect(askings[0]?.expiredAt).toBe(askings[0]?.request.deadlineAt);
      expect(askings[0]?.state(Duration.toMillis(Duration.days(9)))).toBe("expired");
      expect(unsettled(askings)).toHaveLength(0);
    }).pipe(Effect.provide(settlingLayer)),
  );

  it.effect("leaves the waiting list when the branch answers on the human's behalf", () =>
    Effect.gen(function* () {
      const executionId = yield* start({
        subject: "settled-reject",
        askings: [1],
        onExpiry: "reject",
      });
      yield* settleThenAdvance(Duration.days(8));

      // The run carried on — the auto-reject is an ordinary verdict to the workflow…
      expect(yield* statusOf(executionId)).toBe("Complete");

      // …and the asking itself still settled as expired: nobody answered, and nobody can.
      const askings = yield* askingsOnFile;
      expect(askings[0]?.expiredAt).toBe(askings[0]?.request.deadlineAt);
      expect(unsettled(askings)).toHaveLength(0);
    }).pipe(Effect.provide(settlingLayer)),
  );

  it.effect("settles the first asking of an escalation and keeps the second waiting", () =>
    Effect.gen(function* () {
      yield* start({ subject: "settled-up", askings: [1], onExpiry: "escalate" });
      yield* settleThenAdvance(deadline);

      const askings = yield* askingsOnFile;
      expect(askings).toHaveLength(2);

      const first = askings.find((gate) => gate.request.asking === "gate/review/1");
      const second = askings.find((gate) => gate.request.asking === "gate/review/1/escalated");
      // The escalated asking is the one on the lead's desk; the expired one is nobody's.
      expect(first?.expiredAt).toBe(first?.request.deadlineAt);
      expect(second?.expiredAt).toBeUndefined();
      expect(unsettled(askings).map((gate) => gate.request.asking)).toEqual([
        "gate/review/1/escalated",
      ]);
    }).pipe(Effect.provide(settlingLayer)),
  );

  it.effect("never settles an asking somebody answered in time", () =>
    Effect.gen(function* () {
      yield* start({ subject: "settled-answered", askings: [1] });
      const token = (yield* askingsOnFile)[0]?.request.token;

      yield* answer(token as DurableDeferred.Token, "approve", "reads fine");
      yield* settleThenAdvance(Duration.days(8));

      // The verdict half of the race won, so no settlement-by-expiry may ever be written: a row
      // that carried both would draw an answered gate as one nobody decided.
      const askings = yield* askingsOnFile;
      expect(askings[0]?.expiredAt).toBeUndefined();
    }).pipe(Effect.provide(settlingLayer)),
  );
});

describe("a scripted gate", () => {
  it.effect("answers from the queue without the run ever suspending", () =>
    Effect.gen(function* () {
      const executionId = yield* start({ subject: "scripted", askings: [1, 2] });

      expect(yield* statusOf(executionId)).toBe("Complete");
      const result = Option.getOrThrow(yield* asked.definition.poll(executionId));
      const exit = (result as Workflow.Complete<ReadonlyArray<Verdict>, never>).exit;
      expect(Exit.isSuccess(exit) && exit.value.map((verdict) => verdict.choice)).toEqual([
        "reject",
        "approve",
      ]);
    }).pipe(
      Effect.provide(
        layerFor({
          review: [
            { choice: "reject", reason: "not yet" },
            { choice: "approve", reason: "now" },
          ],
        }),
      ),
    ),
  );
});
