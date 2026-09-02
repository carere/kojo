import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeString,
  decodeSuccess,
} from "../../shared/codecs/json.ts";

export type RollbackOutcome =
  | { readonly _tag: "Deleted" }
  | { readonly _tag: "Restored" }
  | { readonly _tag: "LeftAsIs" }
  | { readonly _tag: "WorkLost" }
  | { readonly _tag: "NotUndone"; readonly reason: string };

/** Decode the public form of the domain RollbackOutcome without widening its tag to string. */
export const decodeRollbackOutcome = (input: unknown): DecodeResult<RollbackOutcome> => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return decodeFailure([], "Expected one RollbackOutcome object");
  }
  const tag = (input as { readonly _tag?: unknown })._tag;
  if (tag === "NotUndone") {
    const record = decodeClosedRecord(input, ["_tag", "reason"]);
    if (!record.ok) return record;
    const reason = decodeString(record.value.reason, ["reason"], { minLength: 1 });
    return reason.ok ? decodeSuccess({ _tag: "NotUndone", reason: reason.value }) : reason;
  }
  if (tag === "Deleted" || tag === "Restored" || tag === "LeftAsIs" || tag === "WorkLost") {
    const record = decodeClosedRecord(input, ["_tag"]);
    return record.ok ? decodeSuccess({ _tag: tag }) : record;
  }
  return decodeFailure(["_tag"], "Expected a domain RollbackOutcome tag");
};
