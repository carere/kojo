import { expect, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { makeControlSubscription } from "../../../../../../src/contexts/workflow-execution/control/services/local-host";
import {
  decodeExecutionTraceCursor,
  encodeExecutionTraceCursor,
} from "../../../../../../src/contexts/workflow-execution/runs/use-cases/execution-trace-cursor";
import { toExecutionTraceEvent } from "../../../../../../src/contexts/workflow-execution/runs/use-cases/manage-workflow-runs";

const filters = {
  activityAttemptIds: [],
  childRunIds: [],
  engineOperationIds: [],
  kinds: [],
} as const;

it.effect("keeps opaque trace cursors scoped to their Run and settled filters", () =>
  Effect.sync(() => {
    const cursor = encodeExecutionTraceCursor("run-one", "after", 3, filters);
    expect(decodeExecutionTraceCursor(cursor, "run-one", filters)).toMatchObject({
      ok: true,
      cursor: { direction: "after", sequence: 3 },
    });
    expect(decodeExecutionTraceCursor(cursor, "run-two", filters)).toMatchObject({
      ok: false,
      code: "execution-trace-cursor-run-mismatch",
    });
    expect(
      decodeExecutionTraceCursor(cursor, "run-one", { ...filters, kinds: ["run.accepted"] }),
    ).toMatchObject({ ok: false, code: "execution-trace-cursor-filter-mismatch" });
    expect(decodeExecutionTraceCursor(`${cursor}changed`, "run-one", filters)).toMatchObject({
      ok: false,
      code: "execution-trace-cursor-malformed",
    });
  }),
);

it.effect("masks sensitive evidence and makes unsupported Event versions visible", () =>
  Effect.sync(() => {
    const event = {
      activityAttemptId: null,
      boundaryId: null,
      childRunId: null,
      engineOperationId: null,
      envelopeVersion: 1,
      eventId: "event",
      kind: "activity.result-observed",
      kindVersion: 1,
      observedAtMs: null,
      payload: { outcome: "success", token: "secret" },
      payloadSensitivityMap: { valid: true as const, map: { paths: ["token"] } },
      recordedAtMs: 1,
      runId: "run",
      sequence: 1,
    };
    expect(toExecutionTraceEvent(event)).toMatchObject({
      compatibility: "supported",
      payload: { outcome: "success", token: { _tag: "sensitive-value-masked" } },
    });
    expect(toExecutionTraceEvent({ ...event, envelopeVersion: 2 })).toMatchObject({
      compatibility: "envelope-version-unsupported",
      payload: { _tag: "sensitive-value-masked" },
    });
  }),
);

it.effect("selects trace topics by Project and asks slow consumers to resync", () =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const update = yield* makeControlSubscription((input) => {
      seen.push(`${input.identity}:${input.runId}`);
      return Effect.succeed({
        ok: true as const,
        page: {
          events: [],
          final: false,
          highWaterSequence: 201,
          nextCursor: "more-than-the-bounded-live-page",
          runState: "running" as const,
        },
      });
    })({
      projects: ["project-one" as never],
      topics: ["traces"],
      traces: [
        { identity: "project-one" as never, runId: "run-one" as never, afterSequence: 0 },
        { identity: "project-two" as never, runId: "run-two" as never, afterSequence: 0 },
      ],
    }).pipe(Stream.runHead);

    expect(Option.getOrThrow(update)).toEqual({
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
    const update = yield* makeControlSubscription((input) =>
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
          highWaterSequence: 7,
          nextCursor: null,
          runState: "running" as const,
        },
      }),
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
