import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeInteger,
  decodeJsonValue,
  decodeString,
  decodeSuccess,
  type JsonValue,
} from "../../shared/codecs/json.ts";
import { decodeRunnerIdentity, decodeSha256 } from "../../shared/models/identity.ts";

export interface RegisterRevisionBody {
  readonly registrationVersion: 1;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly workflowName: string;
  readonly retainedRoot: string;
  readonly entrySource: string;
  readonly payload: JsonValue;
}

export interface ExecuteRunBody {
  readonly executionVersion: 1;
  readonly workflowName: string;
  readonly payload: JsonValue;
  readonly recordedResults: Readonly<Record<string, JsonValue>>;
  readonly deferredResults: Readonly<Record<string, JsonValue>>;
  readonly scheduledWakeups: Readonly<Record<string, string>>;
}

export interface ReadResultBody {
  readonly resultVersion: 1;
  readonly phasePath: string;
  readonly attempt: number;
}

export interface CommitActionResultBody extends ReadResultBody {
  readonly kind: "actor" | "code" | "agent";
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly description: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly encodedResult: JsonValue;
}

export type ReplyState = "received" | "progress" | "committed";

export interface OperationReplyBody {
  readonly replyVersion: 1;
  readonly operationRequestId: string;
  readonly state: ReplyState;
  readonly result?: JsonValue;
}

const instant = (input: unknown, path: ReadonlyArray<number | string>): DecodeResult<string> => {
  const value = decodeString(input, path, {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  });
  return value.ok && !Number.isNaN(Date.parse(value.value))
    ? value
    : decodeFailure(path, "Expected an ISO 8601 UTC instant");
};

export const decodeRegisterRevisionBody = (input: unknown): DecodeResult<RegisterRevisionBody> => {
  const record = decodeClosedRecord(input, [
    "registrationVersion",
    "revisionId",
    "packageGraphId",
    "workflowName",
    "retainedRoot",
    "entrySource",
    "payload",
  ]);
  if (!record.ok) return record;
  if (record.value.registrationVersion !== 1)
    return decodeFailure(["registrationVersion"], "Expected registration version 1");
  const revisionId = decodeSha256(record.value.revisionId, ["revisionId"]);
  if (!revisionId.ok) return revisionId;
  const packageGraphId = decodeSha256(record.value.packageGraphId, ["packageGraphId"]);
  if (!packageGraphId.ok) return packageGraphId;
  const workflowName = decodeString(record.value.workflowName, ["workflowName"], { minLength: 1 });
  if (!workflowName.ok) return workflowName;
  const retainedRoot = decodeString(record.value.retainedRoot, ["retainedRoot"], { minLength: 1 });
  if (!retainedRoot.ok) return retainedRoot;
  const entrySource = decodeString(record.value.entrySource, ["entrySource"], { minLength: 1 });
  if (!entrySource.ok) return entrySource;
  const payload = decodeJsonValue(record.value.payload);
  if (!payload.ok) return payload;
  return decodeSuccess({
    registrationVersion: 1,
    revisionId: revisionId.value,
    packageGraphId: packageGraphId.value,
    workflowName: workflowName.value,
    retainedRoot: retainedRoot.value,
    entrySource: entrySource.value,
    payload: payload.value,
  });
};

export const decodeExecuteRunBody = (input: unknown): DecodeResult<ExecuteRunBody> => {
  const record = decodeClosedRecord(input, [
    "executionVersion",
    "workflowName",
    "payload",
    "recordedResults",
    "deferredResults",
    "scheduledWakeups",
  ]);
  if (!record.ok) return record;
  if (record.value.executionVersion !== 1)
    return decodeFailure(["executionVersion"], "Expected execution version 1");
  const workflowName = decodeString(record.value.workflowName, ["workflowName"], { minLength: 1 });
  if (!workflowName.ok) return workflowName;
  const payload = decodeJsonValue(record.value.payload);
  if (!payload.ok) return payload;
  const recordedResults = decodeJsonValue(record.value.recordedResults);
  if (!recordedResults.ok)
    return {
      ok: false,
      issues: recordedResults.issues.map((issue) => ({
        ...issue,
        path: ["recordedResults", ...issue.path],
      })),
    };
  if (
    recordedResults.value === null ||
    Array.isArray(recordedResults.value) ||
    typeof recordedResults.value !== "object"
  ) {
    return decodeFailure(["recordedResults"], "Expected a JSON object of recorded results");
  }
  const deferredResults = decodeJsonValue(record.value.deferredResults);
  if (!deferredResults.ok) return deferredResults;
  if (
    deferredResults.value === null ||
    Array.isArray(deferredResults.value) ||
    typeof deferredResults.value !== "object"
  ) {
    return decodeFailure(["deferredResults"], "Expected a JSON object of Deferred results");
  }
  const scheduledWakeups = decodeJsonValue(record.value.scheduledWakeups);
  if (!scheduledWakeups.ok) return scheduledWakeups;
  if (
    scheduledWakeups.value === null ||
    Array.isArray(scheduledWakeups.value) ||
    typeof scheduledWakeups.value !== "object" ||
    Object.values(scheduledWakeups.value).some((value) => typeof value !== "string")
  ) {
    return decodeFailure(
      ["scheduledWakeups"],
      "Expected a JSON object of absolute wake-up instants",
    );
  }
  return decodeSuccess({
    executionVersion: 1,
    workflowName: workflowName.value,
    payload: payload.value,
    recordedResults: recordedResults.value as Readonly<Record<string, JsonValue>>,
    deferredResults: deferredResults.value as Readonly<Record<string, JsonValue>>,
    scheduledWakeups: scheduledWakeups.value as Readonly<Record<string, string>>,
  });
};

export const decodeReadResultBody = (input: unknown): DecodeResult<ReadResultBody> => {
  const record = decodeClosedRecord(input, ["resultVersion", "phasePath", "attempt"]);
  if (!record.ok) return record;
  if (record.value.resultVersion !== 1)
    return decodeFailure(["resultVersion"], "Expected result version 1");
  const phasePath = decodeString(record.value.phasePath, ["phasePath"], { minLength: 1 });
  if (!phasePath.ok) return phasePath;
  const attempt = decodeInteger(record.value.attempt, ["attempt"], { minimum: 1 });
  if (!attempt.ok) return attempt;
  return decodeSuccess({ resultVersion: 1, phasePath: phasePath.value, attempt: attempt.value });
};

export const decodeCommitActionResultBody = (
  input: unknown,
): DecodeResult<CommitActionResultBody> => {
  const record = decodeClosedRecord(input, [
    "resultVersion",
    "phasePath",
    "attempt",
    "kind",
    "outcome",
    "description",
    "startedAt",
    "endedAt",
    "encodedResult",
  ]);
  if (!record.ok) return record;
  const key = decodeReadResultBody({
    resultVersion: record.value.resultVersion,
    phasePath: record.value.phasePath,
    attempt: record.value.attempt,
  });
  if (!key.ok) return key;
  if (
    record.value.kind !== "actor" &&
    record.value.kind !== "code" &&
    record.value.kind !== "agent"
  )
    return decodeFailure(["kind"], "Expected an authored Phase kind");
  if (
    record.value.outcome !== "succeeded" &&
    record.value.outcome !== "failed" &&
    record.value.outcome !== "interrupted"
  )
    return decodeFailure(["outcome"], "Expected a Phase outcome");
  const description = decodeString(record.value.description, ["description"]);
  if (!description.ok) return description;
  const startedAt = instant(record.value.startedAt, ["startedAt"]);
  if (!startedAt.ok) return startedAt;
  const endedAt = instant(record.value.endedAt, ["endedAt"]);
  if (!endedAt.ok) return endedAt;
  const encodedResult = decodeJsonValue(record.value.encodedResult);
  if (!encodedResult.ok) return encodedResult;
  return decodeSuccess({
    ...key.value,
    kind: record.value.kind,
    outcome: record.value.outcome,
    description: description.value,
    startedAt: startedAt.value,
    endedAt: endedAt.value,
    encodedResult: encodedResult.value,
  });
};

export const decodeOperationReplyBody = (input: unknown): DecodeResult<OperationReplyBody> => {
  const record = decodeClosedRecord(input, [
    "replyVersion",
    "operationRequestId",
    "state",
    "result",
  ]);
  if (!record.ok) return record;
  if (record.value.replyVersion !== 1)
    return decodeFailure(["replyVersion"], "Expected reply version 1");
  const operationRequestId = decodeRunnerIdentity(record.value.operationRequestId, [
    "operationRequestId",
  ]);
  if (!operationRequestId.ok) return operationRequestId;
  if (
    record.value.state !== "received" &&
    record.value.state !== "progress" &&
    record.value.state !== "committed"
  )
    return decodeFailure(["state"], "Expected a reply state");
  if (!("result" in record.value))
    return decodeSuccess({
      replyVersion: 1,
      operationRequestId: operationRequestId.value,
      state: record.value.state,
    });
  const result = decodeJsonValue(record.value.result);
  if (!result.ok) return result;
  return decodeSuccess({
    replyVersion: 1,
    operationRequestId: operationRequestId.value,
    state: record.value.state,
    result: result.value,
  });
};
