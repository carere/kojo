import { describe, expect, it } from "@effect/vitest";
import { Clock, Duration, Effect, Layer, Schema } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import * as InMemoryGateRepository from "../../../../src/contexts/gate/adapters/InMemoryGateRepository.ts";
import * as RecordingGate from "../../../../src/contexts/gate/adapters/RecordingGate.ts";
import { GateExpired } from "../../../../src/contexts/gate/models/GateExpired.ts";
import { GateRequest } from "../../../../src/contexts/gate/models/GateRequest.ts";
import { GateUnreachable } from "../../../../src/contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../../../../src/contexts/gate/models/OnExpiry.ts";
import { Verdict } from "../../../../src/contexts/gate/models/Verdict.ts";
import { GateRepository } from "../../../../src/contexts/gate/ports/GateRepository.ts";
import { answerGate } from "../../../../src/contexts/gate/services/answerGate.ts";
import type { RunId } from "../../../../src/contexts/shared/models/RunId.ts";
import * as InMemoryTracer from "../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import * as InMemoryTrigger from "../../../../src/contexts/trigger/adapters/InMemoryTrigger.ts";
import type { Driven } from "../../../../src/contexts/trigger/models/Driven.ts";
import type { WatchNotice } from "../../../../src/contexts/trigger/models/WatchNotice.ts";
import type { Trigger } from "../../../../src/contexts/trigger/ports/Trigger.ts";
import { runFor } from "../../../../src/contexts/trigger/services/drive.ts";
import { watch } from "../../../../src/contexts/trigger/services/watch.ts";
import * as InMemoryRunLock from "../../../../src/contexts/workflow/adapters/InMemoryRunLock.ts";
import { RunLock } from "../../../../src/contexts/workflow/ports/RunLock.ts";
import { code } from "../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../src/contexts/workflow/services/phase/gate.ts";
import { start, status } from "../../../../src/contexts/workflow/services/run.ts";
import { workflow } from "../../../../src/contexts/workflow/services/workflow.ts";
import { settleThenAdvance } from "../../../support/settleThenAdvance.ts";

/** What a ticket revision looks like once it has been decoded, and what one run is per. */
const payload = { ticket: Schema.String, revision: Schema.Finite };
const deduplicatedBy = (fields: { readonly ticket: string; readonly revision: number }) =>
  `${fields.ticket}@${fields.revision}`;

/** A factory that never asks anybody anything. It exists to be started and to end. */
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

/** The same trigger on a factory that stops and waits for a person. */
const reviewed = workflow(
  {
    name: "reviewed",
    payload,
    success: Verdict,
    error: Schema.Union([GateExpired, GateUnreachable]),
    idempotencyKey: deduplicatedBy,
  },
  () =>
    gate({
      name: "approve",
      description: "Does this land on main?",
      actor: "engineer",
      choices: ["approve", "reject"],
      deadline: Duration.days(2),
      onExpiry: OnExpiry.fail(),
      asking: 1,
    }),
);

/** The two workflows with their generic parameters erased, exactly as the CLI erases them. */
const drivenTriaged: Driven = {
  name: "triaged",
  driven: (event) => runFor(triaged.definition, event),
  status: (runId) => status(triaged.definition, runId),
};

const drivenReviewed: Driven = {
  name: "reviewed",
  driven: (event) => runFor(reviewed.definition, event),
  status: (runId) => status(reviewed.definition, runId),
};

/**
 * A whole watcher, in memory.
 *
 * The gate is the *reference* adapter over an in-memory store, because the askings list is what the
 * watcher reads — a gate that only printed would leave every loop below with nothing to watch.
 */
const factory = (trigger: Layer.Layer<InMemoryTrigger.AcknowledgedEvents | Trigger>) =>
  Layer.mergeAll(triaged.layer, reviewed.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InMemoryTracer.layer,
        trigger,
        InMemoryRunLock.layer({ holder: "the-watcher" }),
        RecordingGate.layer.pipe(Layer.provideMerge(InMemoryGateRepository.layer)),
        WorkflowEngine.layerMemory,
      ),
    ),
  );

const runs = Effect.flatMap(InMemoryTracer.RecordedTrace, (trace) => trace.runs);
const acks = Effect.flatMap(InMemoryTrigger.AcknowledgedEvents, (recorded) => recorded.acks);

const arriving = (ticket: string, revision: number, after?: Duration.Input) => ({
  key: deduplicatedBy({ ticket, revision }),
  payload: { ticket, revision },
  ...(after === undefined ? {} : { after }),
});

/**
 * Starts a watcher on its own fiber and hands back what it has said so far.
 *
 * Forked and never joined: a watcher does not end, which is the whole point of it. The test's scope
 * interrupts it, exactly as Ctrl-C interrupts the command.
 */
const watching = (driving: Driven) =>
  Effect.gen(function* () {
    const notices: Array<WatchNotice> = [];
    yield* Effect.forkChild(
      watch({
        driving,
        known: [drivenTriaged, drivenReviewed],
        report: (notice) => Effect.sync(() => void notices.push(notice)),
        sweepEvery: Duration.seconds(1),
        watchSlice: Duration.seconds(5),
      }),
    );
    return notices;
  });

const of = <Tag extends WatchNotice["_tag"]>(
  notices: ReadonlyArray<WatchNotice>,
  tag: Tag,
): ReadonlyArray<Extract<WatchNotice, { readonly _tag: Tag }>> =>
  notices.filter(
    (notice): notice is Extract<WatchNotice, { readonly _tag: Tag }> => notice._tag === tag,
  );

describe("driving the trigger", () => {
  it.effect("turns an event into a run and says where it ended", () =>
    Effect.gen(function* () {
      const notices = yield* watching(drivenTriaged);
      yield* settleThenAdvance(Duration.seconds(5));
      yield* settleThenAdvance(Duration.seconds(5));

      expect(yield* runs).toHaveLength(1);
      expect(of(notices, "started").map((notice) => notice.key)).toEqual(["KOJO-1@1"]);
      expect(of(notices, "ended").map((notice) => notice.status)).toEqual(["succeeded"]);

      const acknowledged = yield* acks;
      expect(acknowledged).toHaveLength(1);
      expect(acknowledged[0]?.run.outcome).toBe("succeeded");
    }).pipe(Effect.provide(factory(InMemoryTrigger.layer([arriving("KOJO-1", 1)])))),
  );

  it.effect(
    "says a run that stopped for a person is waiting, and acknowledges it as suspended",
    () =>
      Effect.gen(function* () {
        const notices = yield* watching(drivenReviewed);
        yield* settleThenAdvance(Duration.seconds(5));
        yield* settleThenAdvance(Duration.seconds(5));

        // Suspended is a settled answer: the run let go of everything it held, and the source hears
        // so today rather than in two days.
        const waiting = of(notices, "waiting");
        expect(waiting).toHaveLength(1);
        expect(waiting[0]?.gate.request.gate).toBe("approve");
        expect(waiting[0]?.gate.request.actor).toBe("engineer");
        expect((yield* acks)[0]?.run.outcome).toBe("suspended");
      }).pipe(Effect.provide(factory(InMemoryTrigger.layer([arriving("KOJO-2", 1)])))),
  );

  it.effect("two events for one ticket revision produce one run", () =>
    Effect.gen(function* () {
      const notices = yield* watching(drivenTriaged);
      yield* settleThenAdvance(Duration.seconds(5));
      yield* settleThenAdvance(Duration.seconds(5));

      // The redelivery is not dropped — it is acknowledged, because the source is still waiting to
      // hear. What it is told is the run that already exists.
      const started = of(notices, "started");
      expect(started).toHaveLength(2);
      expect(started[0]?.runId).toBe(started[1]?.runId);
      expect(yield* acks).toHaveLength(2);

      // One factory. The trace is where a second one would show, so the trace is what is asserted.
      expect(yield* runs).toHaveLength(1);
    }).pipe(
      Effect.provide(
        factory(InMemoryTrigger.layer([arriving("KOJO-3", 2), arriving("KOJO-3", 2)])),
      ),
    ),
  );

  it.effect("a redelivered event for a run already waiting is answered with that suspension", () =>
    Effect.gen(function* () {
      const notices = yield* watching(drivenReviewed);
      yield* settleThenAdvance(Duration.seconds(5));
      yield* settleThenAdvance(Duration.seconds(5));
      yield* settleThenAdvance(Duration.seconds(5));

      // The second event cannot wait for a suspension that has already happened — that would hang
      // the drive on a gate nobody is going to reach again. It is acknowledged with the asking the
      // run is sitting on, and the watcher does not say the same thing twice.
      expect(of(notices, "started")).toHaveLength(2);
      expect(of(notices, "waiting")).toHaveLength(1);
      const acknowledged = yield* acks;
      expect(acknowledged).toHaveLength(2);
      expect(acknowledged.map((entry) => entry.run.outcome)).toEqual(["suspended", "suspended"]);
    }).pipe(
      Effect.provide(
        factory(InMemoryTrigger.layer([arriving("KOJO-4", 1), arriving("KOJO-4", 1)])),
      ),
    ),
  );

  it.effect("refuses a run another process is already driving rather than racing it", () =>
    Effect.gen(function* () {
      const runId = (yield* triaged.definition.executionId({
        ticket: "KOJO-5",
        revision: 1,
      })) as RunId;

      // Somebody else holds the claim and keeps it. A run id names a branch and a branch names a
      // worktree, so the second driver must be told no (architecture.md §8, edge 9).
      yield* Effect.forkChild(
        Effect.gen(function* () {
          const lock = yield* RunLock;
          yield* lock.claim(runId);
          return yield* Effect.never;
        }).pipe(Effect.scoped),
      );

      const notices = yield* watching(drivenTriaged);
      yield* settleThenAdvance(Duration.seconds(5));
      yield* settleThenAdvance(Duration.seconds(5));

      const refused = of(notices, "refused");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.locked.runId).toBe(runId);
      expect(refused[0]?.locked.holder).toBe("the-watcher");

      // Not acknowledged: whoever holds the run is the one who can say how it went, and telling the
      // source anything else would close a ticket on a run this process never watched.
      expect(yield* acks).toHaveLength(0);
    }).pipe(Effect.provide(factory(InMemoryTrigger.layer([arriving("KOJO-5", 1)])))),
  );
});

describe("adopting runs it did not start", () => {
  it.effect("reports what is waiting, and reports it ending after somebody answers", () =>
    Effect.gen(function* () {
      // A run started before this watcher existed — the previous instance, two days ago.
      const runId = yield* start(reviewed.definition, { ticket: "KOJO-6", revision: 1 });
      yield* settleThenAdvance(Duration.seconds(1));

      const notices = yield* watching(drivenTriaged);
      yield* settleThenAdvance(Duration.seconds(2));

      // The askings list is what remembers the run exists. Nothing about it came from the trigger.
      const waiting = of(notices, "waiting");
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.gate.request.runId).toBe(runId);

      const token = waiting[0]?.gate.request.token ?? ("" as DurableDeferred.Token);
      yield* answerGate({ token, choice: "approve", reason: "ships", answerer: "kevin" });
      yield* settleThenAdvance(Duration.seconds(2));
      yield* settleThenAdvance(Duration.seconds(2));

      const ended = of(notices, "ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]?.runId).toBe(runId);
      expect(ended[0]?.status).toBe("succeeded");
    }).pipe(Effect.provide(factory(InMemoryTrigger.layer([])))),
  );

  it.effect("surfaces a run past its deadline rather than burying it", () =>
    Effect.gen(function* () {
      // Written straight into the store, because the case this is about is a deadline that passed
      // while **nobody was running**: the durable clock that fails an expired gate only fires when
      // a runner is there, so the honest fixture is an asking that is already late.
      const now = yield* Clock.currentTimeMillis;
      const repository = yield* GateRepository;
      yield* repository.asked(
        new GateRequest({
          runId: "run-nobody-looked-at" as RunId,
          gate: "approve",
          asking: "gate/approve/1",
          description: "does this land?",
          actor: "engineer",
          choices: ["approve", "reject"],
          token: new DurableDeferred.TokenParsed({
            workflowName: "reviewed",
            executionId: "run-nobody-looked-at",
            deferredName: "gate/approve/1",
          }).asToken,
          requestedAt: now - Duration.toMillis(Duration.days(3)),
          deadlineAt: now - Duration.toMillis(Duration.days(1)),
          onExpiry: "fail",
        }),
      );

      const notices = yield* watching(drivenTriaged);
      yield* settleThenAdvance(Duration.seconds(2));

      const overdue = of(notices, "overdue");
      expect(overdue).toHaveLength(1);
      expect(overdue[0]?.gate.request.runId).toBe("run-nobody-looked-at");
      expect(overdue[0]?.gate.remainingMillis(yield* Clock.currentTimeMillis)).toBeLessThan(0);

      // Said once. A watcher that repeated it every sweep would train its reader to ignore it.
      yield* settleThenAdvance(Duration.seconds(5));
      expect(of(notices, "overdue")).toHaveLength(1);
    }).pipe(Effect.provide(factory(InMemoryTrigger.layer([])))),
  );
});
