import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeJsonValue,
  decodeString,
  decodeSuccess,
  type JsonValue,
} from "../../shared/codecs/json.ts";
import {
  decodeOpaqueIdentity,
  decodeStructuredIdentity,
  type StructuredIdentity,
} from "../../shared/models/identity.ts";

export type ReceiptStatus = "accepted" | "committed";
export type RetryDisposition = "lookupOriginal" | "never" | "safe";

export interface OperationReceipt {
  readonly receiptVersion: 1;
  readonly requestId: string;
  readonly dataIdentity: string;
  readonly operation: string;
  readonly status: ReceiptStatus;
  readonly result?: JsonValue;
}

export interface Problem {
  readonly problemVersion: 1;
  readonly code: string;
  readonly scope: StructuredIdentity;
  readonly retry: RetryDisposition;
  readonly remedy: string;
  readonly diagnostic?: string;
}

export interface OperationRefusal {
  readonly refusalVersion: 1;
  readonly requestId: string;
  readonly dataIdentity: string;
  readonly problem: Problem;
}

const operationName = (input: unknown, path: ReadonlyArray<number | string>) =>
  decodeString(input, path, { minLength: 1, pattern: /^[a-z][A-Za-z0-9]*$/ });

export const decodeOperationReceipt = (input: unknown): DecodeResult<OperationReceipt> => {
  const record = decodeClosedRecord(input, [
    "receiptVersion",
    "requestId",
    "dataIdentity",
    "operation",
    "status",
    "result",
  ]);
  if (!record.ok) return record;
  if (record.value.receiptVersion !== 1) {
    return decodeFailure(["receiptVersion"], "Expected receipt version 1");
  }
  const requestId = decodeOpaqueIdentity(record.value.requestId, ["requestId"]);
  if (!requestId.ok) return requestId;
  const dataIdentity = decodeOpaqueIdentity(record.value.dataIdentity, ["dataIdentity"]);
  if (!dataIdentity.ok) return dataIdentity;
  const operation = operationName(record.value.operation, ["operation"]);
  if (!operation.ok) return operation;
  if (record.value.status !== "accepted" && record.value.status !== "committed") {
    return decodeFailure(["status"], "Expected accepted or committed");
  }
  if (!("result" in record.value)) {
    return decodeSuccess({
      receiptVersion: 1,
      requestId: requestId.value,
      dataIdentity: dataIdentity.value,
      operation: operation.value,
      status: record.value.status,
    });
  }
  const result = decodeJsonValue(record.value.result);
  if (!result.ok) {
    return {
      ok: false,
      issues: result.issues.map((issue) => ({ ...issue, path: ["result", ...issue.path] })),
    };
  }
  return decodeSuccess({
    receiptVersion: 1,
    requestId: requestId.value,
    dataIdentity: dataIdentity.value,
    operation: operation.value,
    status: record.value.status,
    result: result.value,
  });
};

export const decodeProblem = (
  input: unknown,
  path: ReadonlyArray<number | string> = [],
): DecodeResult<Problem> => {
  const record = decodeClosedRecord(
    input,
    ["problemVersion", "code", "scope", "retry", "remedy", "diagnostic"],
    path,
  );
  if (!record.ok) return record;
  if (record.value.problemVersion !== 1) {
    return decodeFailure([...path, "problemVersion"], "Expected problem version 1");
  }
  const code = decodeString(record.value.code, [...path, "code"], {
    minLength: 1,
    pattern: /^[A-Z][A-Z0-9_]*$/,
  });
  if (!code.ok) return code;
  const scope = decodeStructuredIdentity(record.value.scope, [...path, "scope"]);
  if (!scope.ok) return scope;
  if (
    record.value.retry !== "lookupOriginal" &&
    record.value.retry !== "never" &&
    record.value.retry !== "safe"
  ) {
    return decodeFailure([...path, "retry"], "Expected a retry disposition");
  }
  const remedy = decodeString(record.value.remedy, [...path, "remedy"], { minLength: 1 });
  if (!remedy.ok) return remedy;
  if (!("diagnostic" in record.value)) {
    return decodeSuccess({
      problemVersion: 1,
      code: code.value,
      scope: scope.value,
      retry: record.value.retry,
      remedy: remedy.value,
    });
  }
  const diagnostic = decodeString(record.value.diagnostic, [...path, "diagnostic"], {
    minLength: 1,
  });
  if (!diagnostic.ok) return diagnostic;
  return decodeSuccess({
    problemVersion: 1,
    code: code.value,
    scope: scope.value,
    retry: record.value.retry,
    remedy: remedy.value,
    diagnostic: diagnostic.value,
  });
};

export const decodeOperationRefusal = (input: unknown): DecodeResult<OperationRefusal> => {
  const record = decodeClosedRecord(input, [
    "refusalVersion",
    "requestId",
    "dataIdentity",
    "problem",
  ]);
  if (!record.ok) return record;
  if (record.value.refusalVersion !== 1) {
    return decodeFailure(["refusalVersion"], "Expected refusal version 1");
  }
  const requestId = decodeOpaqueIdentity(record.value.requestId, ["requestId"]);
  if (!requestId.ok) return requestId;
  const dataIdentity = decodeOpaqueIdentity(record.value.dataIdentity, ["dataIdentity"]);
  if (!dataIdentity.ok) return dataIdentity;
  const problem = decodeProblem(record.value.problem, ["problem"]);
  if (!problem.ok) return problem;
  return decodeSuccess({
    refusalVersion: 1,
    requestId: requestId.value,
    dataIdentity: dataIdentity.value,
    problem: problem.value,
  });
};
