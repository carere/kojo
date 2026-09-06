import { Schema } from "effect";
import type { YieldableError } from "effect/Cause";
import { DecodeIssue } from "../../shared/models/DecodeIssue.ts";

const EnvelopeParseErrorBase: Schema.Class<
  EnvelopeParseError,
  Schema.TaggedStruct<
    "EnvelopeParseError",
    {
      readonly agent: Schema.String;
      readonly expected: Schema.String;
      readonly issues: Schema.$Array<typeof DecodeIssue>;
      readonly raw: Schema.String;
    }
  >,
  YieldableError
> = Schema.TaggedError<EnvelopeParseError>()("EnvelopeParseError", {
  agent: Schema.String,
  /** The envelope identifier the phase asked for, so the trace says what was expected. */
  expected: Schema.String,
  issues: Schema.Array(DecodeIssue),
  raw: Schema.String,
});

/**
 * An agent answered, and the answer is not the envelope it was asked for.
 *
 * This is the correction loop's input, not a fault to report and stop on: the issues become the
 * next prompt, in the same agent session. That is why the failure travels as a list of path-precise
 * issues rather than a rendered message — feedback that names the field is feedback an agent can
 * act on.
 *
 * `raw` is what the agent actually said, kept verbatim. Reconstructing it from the issue list is
 * impossible, and it is the first thing a human wants when a correction loop ran out of retries.
 */
export class EnvelopeParseError extends EnvelopeParseErrorBase {
  static fromSchemaError(
    options: { readonly agent: string; readonly expected: string; readonly raw: string },
    error: Schema.SchemaError,
  ): EnvelopeParseError {
    return new EnvelopeParseError({ ...options, issues: DecodeIssue.fromSchemaError(error) });
  }
}
