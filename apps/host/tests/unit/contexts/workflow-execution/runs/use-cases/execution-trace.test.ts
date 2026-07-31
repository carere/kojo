import { expect, it } from "@effect/vitest";
import { LEGACY_PERSISTED_EXECUTION_EVENT_KINDS_V1 } from "@kojo/control";
import { Effect } from "effect";
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
    for (const kind of LEGACY_PERSISTED_EXECUTION_EVENT_KINDS_V1) {
      expect(toExecutionTraceEvent({ ...event, kind })).toMatchObject({
        compatibility: "supported",
        payload: { outcome: "success", token: { _tag: "sensitive-value-masked" } },
      });
      expect(
        toExecutionTraceEvent({
          ...event,
          kind,
          payloadSensitivityMap: { valid: false as const },
        }),
      ).toMatchObject({
        compatibility: "supported",
        payload: { _tag: "sensitive-value-masked" },
      });
    }
    expect(toExecutionTraceEvent({ ...event, kind: "sandbox.unknown" })).toMatchObject({
      compatibility: "kind-version-unsupported",
      payload: { _tag: "sensitive-value-masked" },
    });
  }),
);
