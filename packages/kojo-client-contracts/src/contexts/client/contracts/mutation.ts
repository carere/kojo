import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeJsonValue,
  decodeString,
  decodeSuccess,
  type JsonObject,
} from "../../shared/codecs/json.ts";
import {
  decodeOpaqueIdentity,
  decodeStructuredIdentity,
  type StructuredIdentity,
} from "../../shared/models/identity.ts";

export interface MutationEnvelope {
  readonly mutationVersion: 1;
  readonly requestId: string;
  readonly dataIdentity: string;
  readonly operation: string;
  readonly target: StructuredIdentity;
  readonly arguments: JsonObject;
  readonly preconditions: JsonObject;
}

const decodeJsonObject = (
  input: unknown,
  path: ReadonlyArray<number | string>,
): DecodeResult<JsonObject> => {
  const decoded = decodeJsonValue(input);
  if (!decoded.ok) {
    return {
      ok: false,
      issues: decoded.issues.map((issue) => ({ ...issue, path: [...path, ...issue.path] })),
    };
  }
  if (decoded.value === null || Array.isArray(decoded.value) || typeof decoded.value !== "object") {
    return decodeFailure(path, "Expected a JSON object");
  }
  return decodeSuccess(decoded.value as JsonObject);
};

export const decodeMutationEnvelope = (input: unknown): DecodeResult<MutationEnvelope> => {
  const record = decodeClosedRecord(input, [
    "mutationVersion",
    "requestId",
    "dataIdentity",
    "operation",
    "target",
    "arguments",
    "preconditions",
  ]);
  if (!record.ok) return record;
  if (record.value.mutationVersion !== 1) {
    return decodeFailure(["mutationVersion"], "Expected mutation version 1");
  }
  const requestId = decodeOpaqueIdentity(record.value.requestId, ["requestId"]);
  if (!requestId.ok) return requestId;
  const dataIdentity = decodeOpaqueIdentity(record.value.dataIdentity, ["dataIdentity"]);
  if (!dataIdentity.ok) return dataIdentity;
  const operation = decodeString(record.value.operation, ["operation"], {
    minLength: 1,
    pattern: /^[a-z][A-Za-z0-9]*$/,
  });
  if (!operation.ok) return operation;
  const target = decodeStructuredIdentity(record.value.target, ["target"]);
  if (!target.ok) return target;
  const argumentsValue = decodeJsonObject(record.value.arguments, ["arguments"]);
  if (!argumentsValue.ok) return argumentsValue;
  const preconditions = decodeJsonObject(record.value.preconditions, ["preconditions"]);
  if (!preconditions.ok) return preconditions;
  return decodeSuccess({
    mutationVersion: 1,
    requestId: requestId.value,
    dataIdentity: dataIdentity.value,
    operation: operation.value,
    target: target.value,
    arguments: argumentsValue.value,
    preconditions: preconditions.value,
  });
};
