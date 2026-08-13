import type { Effect } from "effect";
import { Schema, type SchemaAST, type SchemaError } from "effect";

/**
 * Every issue, never the first one.
 *
 * `SchemaAST.ParseOptions.errors` defaults to `"first"`, so an envelope with three bad fields
 * reports one — and the correction loop then spends one whole retry, one whole agent call, per
 * field. `toStandardSchemaV1` hardcodes `"all"` internally, so leaving the default in place also
 * makes Kojo's own decode path and the Standard Schema path disagree about the same input.
 */
const everyIssue: SchemaAST.ParseOptions = { errors: "all" };

/**
 * The one decode path in Kojo.
 *
 * Everything that arrives from outside the process is decoded here — an agent's JSON envelope, the
 * roster, a trace row, a CLI argument. It is a helper rather than a convention because a convention
 * is a thing a call site can forget: the option that matters is applied once, here, and the
 * per-application options that would override it are deliberately not forwarded.
 */
export const decodeUnknown =
  <S extends Schema.Constraint>(schema: S) =>
  (input: unknown): Effect.Effect<S["Type"], SchemaError.SchemaError, S["DecodingServices"]> =>
    Schema.decodeUnknownEffect(schema, everyIssue)(input);
