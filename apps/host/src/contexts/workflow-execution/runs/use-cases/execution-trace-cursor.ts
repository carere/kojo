import { createHash } from "node:crypto";
import type { ExecutionTraceFilters } from "@kojo/control";

interface ExecutionTraceCursor {
  readonly checksum: string;
  readonly direction: "after" | "before";
  readonly filters: string;
  readonly resourceKind: "execution-trace";
  readonly runId: string;
  readonly sequence: number;
  readonly version: 1;
}

export type ExecutionTraceCursorDecode =
  | { readonly ok: true; readonly cursor: ExecutionTraceCursor }
  | {
      readonly ok: false;
      readonly code:
        | "execution-trace-cursor-malformed"
        | "execution-trace-cursor-version-unsupported"
        | "execution-trace-cursor-filter-mismatch"
        | "execution-trace-cursor-run-mismatch";
      readonly message: string;
    };

const checksum = (contents: Omit<ExecutionTraceCursor, "checksum">) =>
  createHash("sha256").update(JSON.stringify(contents)).digest("base64url");

/** Filter order is not semantic, so equivalent filters share a cursor. */
export const executionTraceFilterFingerprint = (filters: ExecutionTraceFilters) =>
  JSON.stringify({
    activityNames: [...(filters.activityNames ?? [])].sort(),
    activityAttemptIds: [...filters.activityAttemptIds].sort(),
    artifactConditions: [...(filters.artifactConditions ?? [])].sort(),
    boundaryIds: [...(filters.boundaryIds ?? [])].sort(),
    childRunIds: [...filters.childRunIds].sort(),
    engineOperationIds: [...filters.engineOperationIds].sort(),
    eventFamilies: [...(filters.eventFamilies ?? [])].sort(),
    kinds: [...filters.kinds].sort(),
    occurrenceOutcomes: [...(filters.occurrenceOutcomes ?? [])].sort(),
    parentRunIds: [...(filters.parentRunIds ?? [])].sort(),
    recordedAfterMs: filters.recordedAfterMs ?? null,
    recordedBeforeMs: filters.recordedBeforeMs ?? null,
    runStates: [...(filters.runStates ?? [])].sort(),
    scheduleKeys: [...(filters.scheduleKeys ?? [])].sort(),
    triggerKinds: [...(filters.triggerKinds ?? [])].sort(),
    workflowKeys: [...(filters.workflowKeys ?? [])].sort(),
  });

export const encodeExecutionTraceCursor = (
  runId: string,
  direction: "after" | "before",
  sequence: number,
  filters: ExecutionTraceFilters,
) => {
  const contents = {
    version: 1 as const,
    resourceKind: "execution-trace" as const,
    runId,
    direction,
    sequence,
    filters: executionTraceFilterFingerprint(filters),
  };
  return Buffer.from(JSON.stringify({ ...contents, checksum: checksum(contents) })).toString(
    "base64url",
  );
};

export const decodeExecutionTraceCursor = (
  encoded: string,
  runId: string,
  filters: ExecutionTraceFilters,
): ExecutionTraceCursorDecode => {
  let parsed: Partial<ExecutionTraceCursor>;
  try {
    parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<ExecutionTraceCursor>;
  } catch {
    return {
      ok: false,
      code: "execution-trace-cursor-malformed",
      message: "This Execution Trace cursor is malformed.",
    };
  }
  if (parsed.version !== 1) {
    return {
      ok: false,
      code: "execution-trace-cursor-version-unsupported",
      message: "This Execution Trace cursor version is not supported.",
    };
  }
  const parsedRunId = parsed.runId;
  const parsedResourceKind = parsed.resourceKind;
  const parsedDirection = parsed.direction;
  const parsedSequence = parsed.sequence;
  const parsedFilters = parsed.filters;
  const parsedChecksum = parsed.checksum;
  if (
    typeof parsedRunId !== "string" ||
    parsedResourceKind !== "execution-trace" ||
    (parsedDirection !== "after" && parsedDirection !== "before") ||
    typeof parsedSequence !== "number" ||
    !Number.isInteger(parsedSequence) ||
    parsedSequence < 1 ||
    typeof parsedFilters !== "string" ||
    typeof parsedChecksum !== "string"
  ) {
    return {
      ok: false,
      code: "execution-trace-cursor-malformed",
      message: "This Execution Trace cursor is malformed.",
    };
  }
  const contents = {
    version: parsed.version,
    resourceKind: parsedResourceKind,
    runId: parsedRunId,
    direction: parsedDirection,
    sequence: parsedSequence,
    filters: parsedFilters,
  } as const;
  if (parsedChecksum !== checksum(contents)) {
    return {
      ok: false,
      code: "execution-trace-cursor-malformed",
      message: "This Execution Trace cursor checksum is invalid.",
    };
  }
  if (parsedRunId !== runId) {
    return {
      ok: false,
      code: "execution-trace-cursor-run-mismatch",
      message: "This Execution Trace cursor belongs to a different Workflow Run.",
    };
  }
  if (parsedFilters !== executionTraceFilterFingerprint(filters)) {
    return {
      ok: false,
      code: "execution-trace-cursor-filter-mismatch",
      message: "This Execution Trace cursor belongs to different filters.",
    };
  }
  return { ok: true, cursor: { ...contents, checksum: parsedChecksum } };
};
