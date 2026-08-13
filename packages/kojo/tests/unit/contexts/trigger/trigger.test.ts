import { describe, expect, it } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Layer, Queue, Result, Schema, Stream } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import * as InMemoryGate from "../../../../src/contexts/gate/adapters/InMemoryGate.ts";
import * as InMemoryGateRepository from "../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import { GateExpired } from "../../../../src/contexts/gate/models/GateExpired.ts";
import { GateUnreachable } from "../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../src/contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../../../../src/contexts/gate/models/Verdict.ts";
import * as InMemoryTracer from "../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import * as InMemoryTrigger from "../../../../src/contexts/trigger/adapters/InMemoryTrigger.ts";
import * as ManualTrigger from "../../../../src/contexts/trigger/adapters/ManualTrigger.ts";
import { TriggerEvent } from "../../../../src/contexts/trigger/models/TriggerEvent.ts";
import { Trigger } from "../../../../src/contexts/trigger/ports/Trigger.ts";
import { drive } from "../../../../src/contexts/trigger/services/drive.ts";
import { code } from "../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../src/contexts/workflow/services/phase/gate.ts";
import { workflow } from "../../../../src/contexts/workflow/services/workflow.ts";
import { settleThenAdvance } from "../../../support/settleThenAdvance.ts";

/** What a ticket revision looks like once it has been decoded. Deduplicated by revision, not ticket. */
const payload = { ticket: Schema.String, revision: Schema.Finite };

/** The dedup value both workflows below agree with: one run per *revision* of a ticket. */
const deduplicatedBy = (fields: { readonly ticket: string; readonly revision: number }) =>
  `${fields.ticket}@${fields.revision}`;

/** The whole factory, in one code phase. It exists to be started, not to be interesting. */
const triaged = workflow(
  {
    name: "triaged",
    payload,
    success: Schema.String,
    error: Schema.Never,
    idempotencyKey: deduplicatedBy,
  },
  (fields) =>
    code(
      {
        name: "triage",
        description: "Read the ticket and say what it is",
        success: Schema.String,
        error: Schema.Never,
      },
      Effect.succeed(`${fields.ticket} triaged`),
    ),
);

/** The same trigger, on a factory that stops and waits for a person. */
const reviewed = workflow(
  {
    name: "reviewed-from-a-trigger",
    payload,
    success: Verdict,
    error: Schema.Union([GateExpired, GateUnreachable]),
    idempotencyKey: deduplicatedBy,
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

const factory = <A>(
  trigger: Layer.Layer<A>,
  answers: Record<string, ReadonlyArray<InMemoryGate.ProgrammedAnswer>> = {},
) =>
  Layer.mergeAll(triaged.layer, reviewed.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InMemoryTracer.layer,
        trigger,
        InMemoryGate.layer(answers).pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
        // The gate phase now writes an expiry settlement where the queue reads, so every workflow
        // body consumes the repository beside the gate.
        InMemoryGateRepository.layer,
      ),
    ),
  );

/**
 * Slow enough that a test says how many polls it is allowing, fast enough to say it in seconds.
 *
 * Every wait in this file is virtual: the drive runs on its own fiber and the test moves the clock,
 * exactly as a poller or a cron adapter will be tested.
 */
const poll = Duration.seconds(1);

const runs = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.runs);
const acks = Effect.flatMap(InMemoryTrigger.AcknowledgedEvents, (recorded) => recorded.acks);

const arriving = (ticket: string, revision: number, after?: Duration.Input) => ({
  key: deduplicatedBy({ ticket, revision }),
  payload: { ticket, revision },
  ...(after === undefined ? {} : { after }),
});

describe("one interface, four shapes", () => {
  it.effect("the manual adapter emits one event and ends", () =>
    Effect.gen(function* () {
      // Read as a stream first, because "and ends" is the half a driven run would hide: a source
      // that never completed would leave `kojo run` sitting there with its work already done.
      const trigger = yield* Trigger;
      yield* settleThenAdvance(Duration.minutes(5));
      const emitted = yield* Stream.runCollect(trigger.stream);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.source).toBe("manual");
      expect(emitted[0]?.key).toBe("KOJO-1@1");
      // Stamped when the event was pulled, from the Clock — not when the layer was built.
      expect(emitted[0]?.receivedAt).toBe(Duration.toMillis(Duration.minutes(5)));
    }).pipe(
      Effect.provide(
        factory(
          ManualTrigger.layer({ key: "KOJO-1@1", payload: { ticket: "KOJO-1", revision: 1 } }),
        ),
      ),
    ),
  );

  it.effect("a manual event drives a whole run and is acknowledged", () =>
    Effect.gen(function* () {
      const driving = yield* Effect.forkChild(drive(triaged.definition, { poll }));
      yield* settleThenAdvance(Duration.seconds(5));

      // The stream ended, so the drive returned: one unit of work, dealt with, process free to exit.
      yield* Fiber.join(driving);
      expect(yield* runs).toHaveLength(1);
      expect((yield* runs)[0]?.workflow).toBe("triaged");
    }).pipe(
      Effect.provide(
        factory(
          ManualTrigger.layer({ key: "KOJO-2@7", payload: { ticket: "KOJO-2", revision: 7 } }),
        ),
      ),
    ),
  );

  it.effect("a poller emits on an interval, and each tick is one run", () =>
    Effect.gen(function* () {
      yield* Effect.forkChild(drive(triaged.definition, { poll }));

      // Nothing has been read yet: the source only looks once a minute.
      yield* settleThenAdvance(Duration.seconds(5));
      expect(yield* runs).toHaveLength(0);

      yield* settleThenAdvance(Duration.minutes(1));
      yield* settleThenAdvance(Duration.seconds(5));
      expect(yield* runs).toHaveLength(1);
      expect(yield* acks).toHaveLength(1);

      // The second look is another minute away, and no amount of polling brings it forward.
      yield* settleThenAdvance(Duration.seconds(5));
      expect(yield* runs).toHaveLength(1);

      yield* settleThenAdvance(Duration.minutes(1));
      yield* settleThenAdvance(Duration.seconds(5));
      expect(yield* runs).toHaveLength(2);
    }).pipe(
      Effect.provide(
        factory(
          InMemoryTrigger.layer([
            arriving("KOJO-3", 1, Duration.minutes(1)),
            arriving("KOJO-4", 1, Duration.minutes(1)),
          ]),
        ),
      ),
    ),
  );

  it.effect("a webhook receiver emits on request", () =>
    Effect.gen(function* () {
      // A receiving half nobody has written yet: whatever accepts the POST offers to this queue,
      // and the driver above it is the same driver the poller and the manual command use.
      const posted = yield* Queue.make<TriggerEvent>();
      const received = Layer.succeed(Trigger)({
        stream: Stream.fromQueue(posted),
        ack: () => Effect.void,
      });

      yield* Effect.gen(function* () {
        yield* Effect.forkChild(drive(triaged.definition, { poll }));
        yield* settleThenAdvance(Duration.seconds(5));
        expect(yield* runs).toHaveLength(0);

        yield* Queue.offer(
          posted,
          new TriggerEvent({
            source: "webhook/github",
            key: "KOJO-5@2",
            payload: { ticket: "KOJO-5", revision: 2 },
            receivedAt: yield* Clock.currentTimeMillis,
          }),
        );
        yield* settleThenAdvance(Duration.seconds(5));

        expect(yield* runs).toHaveLength(1);
      }).pipe(Effect.provide(factory(received)));
    }),
  );
});

describe("what a run is deduplicated by", () => {
  it.effect("two events for one ticket revision produce exactly one run", () =>
    Effect.gen(function* () {
      const driving = yield* Effect.forkChild(drive(triaged.definition, { poll }));
      yield* settleThenAdvance(Duration.seconds(10));
      yield* Fiber.join(driving);

      // The redelivery is not dropped — it is acknowledged, because the source is still waiting to
      // hear. What it is told is the run that already exists.
      const acknowledged = yield* acks;
      expect(acknowledged).toHaveLength(2);
      expect(acknowledged[0]?.run.runId).toBe(acknowledged[1]?.run.runId);
      expect(acknowledged.map((entry) => entry.run.outcome)).toEqual(["succeeded", "succeeded"]);

      // One factory. The trace is where a second one would show, so the trace is what is asserted.
      expect(yield* runs).toHaveLength(1);
    }).pipe(
      Effect.provide(
        factory(InMemoryTrigger.layer([arriving("KOJO-6", 4), arriving("KOJO-6", 4)])),
      ),
    ),
  );

  it.effect("a second revision of the same ticket is a second run", () =>
    Effect.gen(function* () {
      const driving = yield* Effect.forkChild(drive(triaged.definition, { poll }));
      yield* settleThenAdvance(Duration.seconds(10));
      yield* Fiber.join(driving);

      const started = yield* runs;
      expect(started).toHaveLength(2);
      expect(started[0]?.runId).not.toBe(started[1]?.runId);
    }).pipe(
      Effect.provide(
        factory(InMemoryTrigger.layer([arriving("KOJO-6", 4), arriving("KOJO-6", 5)])),
      ),
    ),
  );

  it.effect("an event that disagrees with the workflow about its key starts nothing", () =>
    Effect.gen(function* () {
      // The failure this catches is silent otherwise: the run would start, and the *next* delivery
      // of the same ticket revision would start a second one.
      const outcome = yield* Effect.result(drive(triaged.definition, { poll }));

      expect(Result.isFailure(outcome)).toBe(true);
      const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
      expect(failure?.fault).toBe("key-mismatch");
      expect(failure?.key).toBe("KOJO-7");
      expect(failure?.reason).toContain("KOJO-7@1");
      expect(yield* runs).toHaveLength(0);
    }).pipe(
      Effect.provide(
        factory(
          InMemoryTrigger.layer([{ key: "KOJO-7", payload: { ticket: "KOJO-7", revision: 1 } }]),
        ),
      ),
    ),
  );

  it.effect("an event whose payload is not one names the field that is wrong", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(drive(triaged.definition, { poll }));

      const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
      expect(failure?.fault).toBe("malformed");
      expect(failure?.issues.map((issue) => issue.path)).toEqual([["revision"]]);
      expect(yield* runs).toHaveLength(0);
    }).pipe(
      Effect.provide(
        factory(
          InMemoryTrigger.layer([
            { key: "KOJO-8@1", payload: { ticket: "KOJO-8", revision: "one" } },
          ]),
        ),
      ),
    ),
  );
});

describe("acknowledging an event", () => {
  it.effect("carries the run and where it stopped", () =>
    Effect.gen(function* () {
      const driving = yield* Effect.forkChild(drive(triaged.definition, { poll }));
      yield* settleThenAdvance(Duration.seconds(5));
      yield* Fiber.join(driving);

      const acknowledged = yield* acks;
      expect(acknowledged).toHaveLength(1);
      expect(acknowledged[0]?.event.key).toBe("KOJO-9@1");
      expect(acknowledged[0]?.event.source).toBe("in-memory");
      expect(acknowledged[0]?.run.outcome).toBe("succeeded");
      expect(acknowledged[0]?.run.runId).toBe((yield* runs)[0]?.runId);
    }).pipe(Effect.provide(factory(InMemoryTrigger.layer([arriving("KOJO-9", 1)])))),
  );

  it.effect("says suspended rather than waiting for the human", () =>
    Effect.gen(function* () {
      const driving = yield* Effect.forkChild(drive(reviewed.definition, { poll }));
      yield* settleThenAdvance(Duration.seconds(5));
      yield* Fiber.join(driving);

      // A gate with nobody scripted to answer it. The ticket hears "waiting on review" today, not
      // in seven days, and the drive is free to take the next event.
      const acknowledged = yield* acks;
      expect(acknowledged).toHaveLength(1);
      expect(acknowledged[0]?.run.outcome).toBe("suspended");
      expect(
        yield* Effect.flatMap(InMemoryGate.RequestedGates, (asked) => asked.requests),
      ).toHaveLength(1);
    }).pipe(Effect.provide(factory(InMemoryTrigger.layer([arriving("KOJO-10", 1)])))),
  );
});
