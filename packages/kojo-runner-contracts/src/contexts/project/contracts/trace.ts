import {
  type DecodePath,
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeString,
  decodeSuccess,
  type JsonObject,
} from "../../shared/codecs/json.ts";

export type TraceMutation =
  | { readonly kind: "run-started"; readonly record: JsonObject }
  | {
      readonly kind: "run-finished";
      readonly runId: string;
      readonly outcome: "succeeded" | "failed" | "suspended";
    }
  | { readonly kind: "phase-entered"; readonly runId: string; readonly phase: JsonObject }
  | { readonly kind: "phase"; readonly record: JsonObject }
  | { readonly kind: "gate"; readonly record: JsonObject }
  | { readonly kind: "sandbox"; readonly record: JsonObject }
  | { readonly kind: "occurrence"; readonly occurrenceId: string; readonly record: JsonObject };

const finite = (input: unknown, path: DecodePath): DecodeResult<number> =>
  typeof input === "number" && Number.isFinite(input)
    ? decodeSuccess(input)
    : decodeFailure(path, "Expected a finite number");

const boolean = (input: unknown, path: DecodePath): DecodeResult<boolean> =>
  typeof input === "boolean" ? decodeSuccess(input) : decodeFailure(path, "Expected a boolean");

const literal = <A extends string>(
  input: unknown,
  values: ReadonlyArray<A>,
  path: DecodePath,
): DecodeResult<A> =>
  typeof input === "string" && values.includes(input as A)
    ? decodeSuccess(input as A)
    : decodeFailure(path, `Expected one of ${values.join(", ")}`);

const optional = <A>(
  record: Record<string, unknown>,
  key: string,
  decode: (input: unknown, path: DecodePath) => DecodeResult<A>,
  path: DecodePath,
): DecodeResult<void> => {
  if (!(key in record)) return decodeSuccess(undefined);
  const result = decode(record[key], [...path, key]);
  return result.ok ? decodeSuccess(undefined) : result;
};

const stringAt = (input: unknown, path: DecodePath): DecodeResult<string> =>
  decodeString(input, path);

const identityAt = (input: unknown, path: DecodePath): DecodeResult<string> =>
  decodeString(input, path, { minLength: 1 });

const stringRecord = (input: unknown, path: DecodePath): DecodeResult<void> => {
  const record = decodeClosedRecord(
    input,
    typeof input === "object" && input !== null && !Array.isArray(input) ? Object.keys(input) : [],
    path,
  );
  if (!record.ok) return record;
  for (const [key, value] of Object.entries(record.value)) {
    const decoded = decodeString(value, [...path, key]);
    if (!decoded.ok) return decoded;
  }
  return decodeSuccess(undefined);
};

const stringArray = (input: unknown, path: DecodePath): DecodeResult<void> => {
  if (!Array.isArray(input)) return decodeFailure(path, "Expected an array");
  for (let index = 0; index < input.length; index += 1) {
    const decoded = decodeString(input[index], [...path, index]);
    if (!decoded.ok) return decoded;
  }
  return decodeSuccess(undefined);
};

const rollback = (input: unknown, path: DecodePath): DecodeResult<void> => {
  const record = decodeClosedRecord(input, ["path", "outcome"], path);
  if (!record.ok) return record;
  const changedPath = decodeString(record.value.path, [...path, "path"]);
  if (!changedPath.ok) return changedPath;
  const outcome = decodeClosedRecord(
    record.value.outcome,
    ["_tag", "reason"],
    [...path, "outcome"],
  );
  if (!outcome.ok) return outcome;
  const tag = literal(
    outcome.value._tag,
    ["Deleted", "Restored", "LeftAsIs", "WorkLost", "NotUndone"],
    [...path, "outcome", "_tag"],
  );
  if (!tag.ok) return tag;
  if (tag.value === "NotUndone") {
    const reason = decodeString(outcome.value.reason, [...path, "outcome", "reason"]);
    return reason.ok ? decodeSuccess(undefined) : reason;
  }
  return "reason" in outcome.value
    ? decodeFailure([...path, "outcome", "reason"], "Unexpected field")
    : decodeSuccess(undefined);
};

const rollbackArray = (input: unknown, path: DecodePath): DecodeResult<void> => {
  if (!Array.isArray(input)) return decodeFailure(path, "Expected an array");
  for (let index = 0; index < input.length; index += 1) {
    const decoded = rollback(input[index], [...path, index]);
    if (!decoded.ok) return decoded;
  }
  return decodeSuccess(undefined);
};

const repo = (input: unknown, path: DecodePath): DecodeResult<void> => {
  const record = decodeClosedRecord(input, ["claimed", "changed", "commits"], path);
  if (!record.ok) return record;
  for (const key of ["claimed", "changed", "commits"] as const) {
    const decoded = stringArray(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  return decodeSuccess(undefined);
};

const agent = (input: unknown, path: DecodePath): DecodeResult<void> => {
  const record = decodeClosedRecord(
    input,
    ["agent", "model", "session", "resumed", "tokensIn", "tokensOut", "contextTokens"],
    path,
  );
  if (!record.ok) return record;
  for (const key of ["agent", "model", "session"] as const) {
    const decoded = stringAt(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const resumed = boolean(record.value.resumed, [...path, "resumed"]);
  if (!resumed.ok) return resumed;
  for (const key of ["tokensIn", "tokensOut"] as const) {
    const decoded = finite(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  return optional(record.value, "contextTokens", finite, path);
};

const verification = (input: unknown, path: DecodePath): DecodeResult<void> => {
  const record = decodeClosedRecord(
    input,
    ["envelope", "ran", "failed", "corrections", "correctable"],
    path,
  );
  if (!record.ok) return record;
  const envelope = decodeString(record.value.envelope, [...path, "envelope"]);
  if (!envelope.ok) return envelope;
  for (const key of ["ran", "failed"] as const) {
    const decoded = stringArray(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const corrections = finite(record.value.corrections, [...path, "corrections"]);
  if (!corrections.ok) return corrections;
  const correctable = boolean(record.value.correctable, [...path, "correctable"]);
  return correctable.ok ? decodeSuccess(undefined) : correctable;
};

const runRecord = (input: unknown, path: DecodePath): DecodeResult<JsonObject> => {
  const record = decodeClosedRecord(
    input,
    [
      "runId",
      "workflow",
      "idempotencyKey",
      "startedAt",
      "engineVersion",
      "engineCommit",
      "configDigest",
      "host",
      "imageDigest",
    ],
    path,
  );
  if (!record.ok) return record;
  for (const key of [
    "runId",
    "workflow",
    "idempotencyKey",
    "engineVersion",
    "engineCommit",
    "configDigest",
    "host",
  ] as const) {
    const decoded = stringAt(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const startedAt = finite(record.value.startedAt, [...path, "startedAt"]);
  if (!startedAt.ok) return startedAt;
  const imageDigest = optional(record.value, "imageDigest", stringAt, path);
  return imageDigest.ok ? decodeSuccess(record.value as JsonObject) : imageDigest;
};

const inFlightPhase = (input: unknown, path: DecodePath): DecodeResult<JsonObject> => {
  const record = decodeClosedRecord(
    input,
    ["phaseId", "name", "kind", "attempt", "startedAt", "sandboxId"],
    path,
  );
  if (!record.ok) return record;
  for (const key of ["phaseId", "name"] as const) {
    const decoded = stringAt(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const kind = literal(record.value.kind, ["actor", "code", "agent"], [...path, "kind"]);
  if (!kind.ok) return kind;
  for (const key of ["attempt", "startedAt"] as const) {
    const decoded = finite(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const sandboxId = optional(record.value, "sandboxId", stringAt, path);
  return sandboxId.ok ? decodeSuccess(record.value as JsonObject) : sandboxId;
};

const phaseRecord = (input: unknown, path: DecodePath): DecodeResult<JsonObject> => {
  const record = decodeClosedRecord(
    input,
    [
      "runId",
      "phaseId",
      "name",
      "description",
      "kind",
      "outcome",
      "attempt",
      "startedAt",
      "endedAt",
      "sandboxId",
      "errorTag",
      "breaches",
      "repo",
      "agent",
      "verification",
    ],
    path,
  );
  if (!record.ok) return record;
  for (const key of ["runId", "phaseId", "name"] as const) {
    const decoded = stringAt(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const description = decodeString(record.value.description, [...path, "description"]);
  if (!description.ok) return description;
  const kind = literal(record.value.kind, ["actor", "code", "agent"], [...path, "kind"]);
  if (!kind.ok) return kind;
  const outcome = literal(
    record.value.outcome,
    ["succeeded", "failed", "interrupted"],
    [...path, "outcome"],
  );
  if (!outcome.ok) return outcome;
  for (const key of ["attempt", "startedAt", "endedAt"] as const) {
    const decoded = finite(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const optionalFields: ReadonlyArray<
    readonly [string, (input: unknown, path: DecodePath) => DecodeResult<unknown>]
  > = [
    ["sandboxId", stringAt],
    ["errorTag", decodeString],
    ["breaches", rollbackArray],
    ["repo", repo],
    ["agent", agent],
    ["verification", verification],
  ];
  for (const [key, decoder] of optionalFields) {
    const decoded = optional<unknown>(record.value, key, decoder, path);
    if (!decoded.ok) return decoded;
  }
  return decodeSuccess(record.value as JsonObject);
};

const gateRecord = (input: unknown, path: DecodePath): DecodeResult<JsonObject> => {
  const record = decodeClosedRecord(
    input,
    [
      "runId",
      "gate",
      "asking",
      "token",
      "description",
      "actor",
      "choices",
      "requestedAt",
      "deadlineAt",
      "onExpiry",
      "outcome",
      "answerer",
      "choice",
      "reason",
      "answeredAt",
    ],
    path,
  );
  if (!record.ok) return record;
  for (const key of ["runId", "gate", "asking", "token", "actor"] as const) {
    const decoded = stringAt(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const description = decodeString(record.value.description, [...path, "description"]);
  if (!description.ok) return description;
  const choices = stringArray(record.value.choices, [...path, "choices"]);
  if (!choices.ok) return choices;
  for (const key of ["requestedAt", "deadlineAt"] as const) {
    const decoded = finite(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const onExpiry = literal(
    record.value.onExpiry,
    ["fail", "reject", "escalate"],
    [...path, "onExpiry"],
  );
  if (!onExpiry.ok) return onExpiry;
  const outcome = literal(record.value.outcome, ["answered", "expired"], [...path, "outcome"]);
  if (!outcome.ok) return outcome;
  for (const key of ["answerer", "choice", "reason"] as const) {
    const decoded = optional(record.value, key, decodeString, path);
    if (!decoded.ok) return decoded;
  }
  const answeredAt = optional(record.value, "answeredAt", finite, path);
  if (!answeredAt.ok) return answeredAt;
  const verdictKeys = ["answerer", "choice", "reason", "answeredAt"] as const;
  if (outcome.value === "answered" && verdictKeys.some((key) => !(key in record.value))) {
    return decodeFailure(path, "An answered Gate requires complete Verdict fields");
  }
  if (outcome.value === "expired" && verdictKeys.some((key) => key in record.value)) {
    return decodeFailure(path, "An expired Gate cannot contain Verdict fields");
  }
  return decodeSuccess(record.value as JsonObject);
};

const sandboxRecord = (input: unknown, path: DecodePath): DecodeResult<JsonObject> => {
  const record = decodeClosedRecord(
    input,
    [
      "runId",
      "sandboxId",
      "name",
      "provider",
      "kind",
      "branch",
      "worktreePath",
      "environment",
      "acquiredAt",
      "releasedAt",
      "outcome",
    ],
    path,
  );
  if (!record.ok) return record;
  for (const key of ["runId", "sandboxId", "name", "provider", "branch", "worktreePath"] as const) {
    const decoded = stringAt(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const kind = literal(record.value.kind, ["bind-mount", "isolated", "none"], [...path, "kind"]);
  if (!kind.ok) return kind;
  const environment = stringRecord(record.value.environment, [...path, "environment"]);
  if (!environment.ok) return environment;
  for (const key of ["acquiredAt", "releasedAt"] as const) {
    const decoded = finite(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const outcome = literal(
    record.value.outcome,
    ["released", "interrupted", "failed"],
    [...path, "outcome"],
  );
  return outcome.ok ? decodeSuccess(record.value as JsonObject) : outcome;
};

const occurrence = (input: unknown, path: DecodePath): DecodeResult<JsonObject> => {
  const record = decodeClosedRecord(
    input,
    ["runId", "phaseId", "kind", "name", "startedAt", "endedAt", "outcome", "detail"],
    path,
  );
  if (!record.ok) return record;
  for (const key of ["runId", "phaseId", "name"] as const) {
    const decoded = stringAt(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const kind = literal(record.value.kind, ["exec", "tool", "iteration"], [...path, "kind"]);
  if (!kind.ok) return kind;
  for (const key of ["startedAt", "endedAt"] as const) {
    const decoded = finite(record.value[key], [...path, key]);
    if (!decoded.ok) return decoded;
  }
  const outcome = literal(record.value.outcome, ["succeeded", "failed"], [...path, "outcome"]);
  if (!outcome.ok) return outcome;
  const detail = optional(record.value, "detail", decodeString, path);
  return detail.ok ? decodeSuccess(record.value as JsonObject) : detail;
};

/** Decode one closed Trace mutation at the private Runner boundary. */
export const decodeTraceMutation = (input: unknown): DecodeResult<TraceMutation> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return decodeFailure([], "Expected a Trace mutation object");
  }
  const kind = (input as Record<string, unknown>).kind;
  if (kind === "run-finished") {
    const record = decodeClosedRecord(input, ["kind", "runId", "outcome"]);
    if (!record.ok) return record;
    const runId = identityAt(record.value.runId, ["runId"]);
    if (!runId.ok) return runId;
    const outcome = literal(
      record.value.outcome,
      ["succeeded", "failed", "suspended"],
      ["outcome"],
    );
    if (!outcome.ok) return outcome;
    return decodeSuccess({ kind, runId: runId.value, outcome: outcome.value });
  }
  if (kind === "phase-entered") {
    const record = decodeClosedRecord(input, ["kind", "runId", "phase"]);
    if (!record.ok) return record;
    const runId = identityAt(record.value.runId, ["runId"]);
    if (!runId.ok) return runId;
    const phase = inFlightPhase(record.value.phase, ["phase"]);
    return phase.ok ? decodeSuccess({ kind, runId: runId.value, phase: phase.value }) : phase;
  }
  const recordValidators = {
    "run-started": runRecord,
    phase: phaseRecord,
    gate: gateRecord,
    sandbox: sandboxRecord,
    occurrence,
  } as const;
  if (!(typeof kind === "string" && kind in recordValidators)) {
    return decodeFailure(["kind"], "Unknown Trace mutation kind");
  }
  const record = decodeClosedRecord(
    input,
    kind === "occurrence" ? ["kind", "occurrenceId", "record"] : ["kind", "record"],
  );
  if (!record.ok) return record;
  const occurrenceId =
    kind === "occurrence" ? identityAt(record.value.occurrenceId, ["occurrenceId"]) : undefined;
  if (occurrenceId !== undefined && !occurrenceId.ok) return occurrenceId;
  const decoded = recordValidators[kind as keyof typeof recordValidators](record.value.record, [
    "record",
  ]);
  return decoded.ok
    ? decodeSuccess(
        kind === "occurrence"
          ? { kind, occurrenceId: occurrenceId?.value as string, record: decoded.value }
          : ({ kind, record: decoded.value } as TraceMutation),
      )
    : decoded;
};
