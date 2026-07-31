import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeControlSubscriptionDeliveryWindow } from "../../../../../../src/contexts/workflow-execution/control/services/control-subscription-delivery-window";
import { followControlSubscription } from "../../../../../../src/contexts/workflow-execution/control/use-cases/follow-control-subscription";

it.effect("selects several Project topics and asks slow consumers to resync", () =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const update = yield* followControlSubscription(
      {
        readResourceFingerprint: () => Effect.succeed("unchanged"),
        readTrace: (input) => {
          seen.push(`${input.identity}:${input.runId}`);
          return Effect.succeed({
            ok: true as const,
            page: {
              events: [],
              final: false,
              firstSequence: null,
              hasMore: true,
              highWaterSequence: 201,
              lastSequence: null,
              nextCursor: "more-than-the-bounded-live-page",
              runState: "running" as const,
            },
          });
        },
      },
      makeControlSubscriptionDeliveryWindow(),
    )({
      projects: ["project-one" as never],
      topics: ["readiness", "runs", "schedules", "traces"],
      traces: [
        { identity: "project-one" as never, runId: "run-one" as never, afterSequence: 0 },
        { identity: "project-two" as never, runId: "run-two" as never, afterSequence: 0 },
      ],
    }).pipe(Stream.runHead);

    expect(Option.getOrThrow(update)).toMatchObject({
      kind: "resync-required",
      identity: "project-one",
      runId: "run-one",
      highWaterSequence: 201,
    });
    expect(seen).toEqual(["project-one:run-one"]);
  }),
);

it.effect("streams a selected durable trace sequence without deriving new state", () =>
  Effect.gen(function* () {
    const update = yield* followControlSubscription(
      {
        readResourceFingerprint: () => Effect.succeed("unchanged"),
        readTrace: (input) =>
          Effect.succeed({
            ok: true as const,
            page: {
              events: [
                {
                  activityAttemptId: null,
                  boundaryId: null,
                  childRunId: null,
                  compatibility: "supported" as const,
                  engineOperationId: null,
                  envelopeVersion: 1,
                  eventId: "event-seven",
                  kind: "run.engine-confirmed",
                  kindVersion: 1,
                  observedAtMs: null,
                  payload: {},
                  recordedAtMs: 7,
                  runId: input.runId,
                  sequence: 7,
                },
              ],
              final: false,
              firstSequence: 7,
              hasMore: false,
              highWaterSequence: 7,
              lastSequence: 7,
              nextCursor: null,
              runState: "running" as const,
            },
          }),
      },
      makeControlSubscriptionDeliveryWindow(),
    )({
      projects: ["project-one" as never],
      topics: ["traces"],
      traces: [{ identity: "project-one" as never, runId: "run-one" as never, afterSequence: 6 }],
    }).pipe(Stream.runHead);

    expect(Option.getOrThrow(update)).toMatchObject({
      kind: "trace-event",
      identity: "project-one",
      runId: "run-one",
      sequence: 7,
      event: { kind: "run.engine-confirmed", sequence: 7 },
    });
  }),
);

it.effect("tells a slow resource-only subscriber which selected resource to resync", () =>
  Effect.gen(function* () {
    const firstFingerprint = yield* Deferred.make<void>();
    const fingerprintReads = yield* Ref.make(0);
    const window = makeControlSubscriptionDeliveryWindow(1);
    const stream = followControlSubscription(
      {
        readResourceFingerprint: () =>
          Effect.gen(function* () {
            const read = yield* Ref.updateAndGet(fingerprintReads, (value) => value + 1);
            if (read === 1) yield* Deferred.succeed(firstFingerprint, undefined);
            return `revision-${read}`;
          }),
        readTrace: () => Effect.die("a resource-only subscription must not read execution traces"),
      },
      window,
    )({
      projects: ["project-one" as never],
      topics: ["runs"],
      traces: [],
    });
    const collect = yield* stream.pipe(Stream.runCollect, Effect.forkScoped);
    yield* Deferred.await(firstFingerprint);

    // The first poll establishes the resource fingerprint. The second update
    // is delivered and the third crosses the unacknowledged window.
    yield* TestClock.adjust("300 millis");
    const updates = Array.from(yield* Fiber.join(collect));
    const resync = updates.at(-1);

    expect(updates.filter((update) => update.kind === "resource-changed")).toHaveLength(1);
    expect(resync).toMatchObject({
      kind: "resync-required",
      identity: "project-one",
      topic: "runs",
    });
    expect(resync).not.toHaveProperty("runId");
    expect(resync).not.toHaveProperty("highWaterSequence");
  }),
);
