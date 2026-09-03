import {
  type DecodeResult,
  decodeClosedRecord,
  decodeFailure,
  decodeInteger,
  decodeString,
  decodeSuccess,
} from "../codecs/json.ts";

export type IdentityPart = number | string;

export interface StructuredIdentity {
  readonly identityVersion: 1;
  readonly kind: string;
  readonly parts: ReadonlyArray<IdentityPart>;
}

export const decodeOpaqueIdentity = (
  input: unknown,
  path: ReadonlyArray<number | string> = [],
): DecodeResult<string> => decodeString(input, path, { minLength: 1, pattern: /^[A-Za-z0-9_-]+$/ });

export const decodeStructuredIdentity = (
  input: unknown,
  path: ReadonlyArray<number | string> = [],
): DecodeResult<StructuredIdentity> => {
  const record = decodeClosedRecord(input, ["identityVersion", "kind", "parts"], path);
  if (!record.ok) return record;
  if (record.value.identityVersion !== 1) {
    return decodeFailure([...path, "identityVersion"], "Expected identity version 1");
  }
  const kind = decodeString(record.value.kind, [...path, "kind"], {
    minLength: 1,
    pattern: /^[a-z][A-Za-z0-9]*$/,
  });
  if (!kind.ok) return kind;
  if (!Array.isArray(record.value.parts) || record.value.parts.length === 0) {
    return decodeFailure([...path, "parts"], "Expected a non-empty identity parts array");
  }
  const parts: IdentityPart[] = [];
  for (let index = 0; index < record.value.parts.length; index += 1) {
    const part = record.value.parts[index];
    if (typeof part === "string") {
      const decoded = decodeString(part, [...path, "parts", index], { minLength: 1 });
      if (!decoded.ok) return decoded;
      parts.push(decoded.value);
      continue;
    }
    const decoded = decodeInteger(part, [...path, "parts", index]);
    if (!decoded.ok) return decoded;
    parts.push(decoded.value);
  }
  return decodeSuccess({ identityVersion: 1, kind: kind.value, parts });
};
