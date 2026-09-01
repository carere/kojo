export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type JsonArray = ReadonlyArray<JsonValue>;

export type JsonObject = { readonly [key: string]: JsonValue };

export type DecodePath = ReadonlyArray<number | string>;

export interface DecodeIssue {
  readonly path: DecodePath;
  readonly message: string;
}

export type DecodeResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly issues: ReadonlyArray<DecodeIssue> };

export const decodeSuccess = <A>(value: A): DecodeResult<A> => ({ ok: true, value });

export const decodeFailure = <A = never>(path: DecodePath, message: string): DecodeResult<A> => ({
  ok: false,
  issues: [{ path, message }],
});

const isPlainRecord = (input: object): input is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
};

const decodeJsonValueAt = (
  input: unknown,
  path: DecodePath,
  ancestors: ReadonlySet<object>,
): DecodeResult<JsonValue> => {
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return decodeSuccess(input);
  }

  if (typeof input === "number") {
    return Number.isFinite(input)
      ? decodeSuccess(input)
      : decodeFailure(path, "Expected a finite JSON number");
  }

  if (typeof input !== "object") {
    return decodeFailure(path, "Expected a JSON value");
  }

  if (ancestors.has(input)) {
    return decodeFailure(path, "Expected an acyclic JSON value");
  }

  const nextAncestors = new Set(ancestors).add(input);
  if (Array.isArray(input)) {
    const values: JsonValue[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return decodeFailure([...path, index], "Expected a JSON array element");
      }
      const decoded = decodeJsonValueAt(descriptor.value, [...path, index], nextAncestors);
      if (!decoded.ok) return decoded;
      values.push(decoded.value);
    }
    const extraKey = Reflect.ownKeys(input).find(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)),
    );
    if (extraKey !== undefined) return decodeFailure(path, "Expected only JSON array elements");
    return decodeSuccess(values);
  }

  if (!isPlainRecord(input)) {
    return decodeFailure(path, "Expected a plain JSON object");
  }

  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    return decodeFailure(path, "JSON object keys must be strings");
  }

  const value: Record<string, JsonValue> = {};
  for (const key of ownKeys) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return decodeFailure([...path, key], "Expected an enumerable JSON field");
    }
    const decoded = decodeJsonValueAt(descriptor.value, [...path, key], nextAncestors);
    if (!decoded.ok) return decoded;
    value[key] = decoded.value;
  }
  return decodeSuccess(value);
};

export const decodeJsonValue = (input: unknown): DecodeResult<JsonValue> =>
  decodeJsonValueAt(input, [], new Set());

/** Encode one JSON value with deterministic object-key order. */
export const encodeCanonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonicalJson).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeCanonicalJson(record[key] ?? null)}`)
    .join(",")}}`;
};

export const decodeClosedRecord = (
  input: unknown,
  allowedKeys: ReadonlyArray<string>,
  path: DecodePath = [],
): DecodeResult<Record<string, unknown>> => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !isPlainRecord(input)
  ) {
    return decodeFailure(path, "Expected an object");
  }

  const symbolKey = Reflect.ownKeys(input).find((key) => typeof key === "symbol");
  if (symbolKey !== undefined) return decodeFailure(path, "Object keys must be strings");

  const invalidDescriptor = Object.keys(input).find((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
  });
  if (invalidDescriptor !== undefined) {
    return decodeFailure([...path, invalidDescriptor], "Expected an enumerable data field");
  }
  if (Reflect.ownKeys(input).length !== Object.keys(input).length) {
    return decodeFailure(path, "Expected only enumerable data fields");
  }

  const extraKey = Object.keys(input).find((key) => !allowedKeys.includes(key));
  return extraKey === undefined
    ? decodeSuccess(input)
    : decodeFailure([...path, extraKey], "Unexpected field");
};

export const decodeString = (
  input: unknown,
  path: DecodePath,
  options: { readonly pattern?: RegExp; readonly minLength?: number } = {},
): DecodeResult<string> => {
  if (typeof input !== "string") return decodeFailure(path, "Expected a string");
  if (input.length < (options.minLength ?? 0))
    return decodeFailure(path, "Expected a non-empty string");
  if (options.pattern !== undefined && !options.pattern.test(input)) {
    return decodeFailure(path, "String has an invalid format");
  }
  return decodeSuccess(input);
};

export const decodeInteger = (
  input: unknown,
  path: DecodePath,
  options: { readonly maximum?: number; readonly minimum?: number } = {},
): DecodeResult<number> => {
  if (!Number.isFinite(input) || !Number.isInteger(input)) {
    return decodeFailure(path, "Expected a finite integer");
  }
  const value = input as number;
  if (options.minimum !== undefined && value < options.minimum) {
    return decodeFailure(path, `Expected an integer greater than or equal to ${options.minimum}`);
  }
  if (options.maximum !== undefined && value > options.maximum) {
    return decodeFailure(path, `Expected an integer less than or equal to ${options.maximum}`);
  }
  return decodeSuccess(value);
};

export const decodeStringArray = (
  input: unknown,
  path: DecodePath,
  options: { readonly unique?: boolean } = {},
): DecodeResult<ReadonlyArray<string>> => {
  if (!Array.isArray(input)) return decodeFailure(path, "Expected an array");
  const values: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const decoded = decodeString(input[index], [...path, index], { minLength: 1 });
    if (!decoded.ok) return decoded;
    if (options.unique === true && values.includes(decoded.value)) {
      return decodeFailure([...path, index], "Expected a unique value");
    }
    values.push(decoded.value);
  }
  return decodeSuccess(values);
};
