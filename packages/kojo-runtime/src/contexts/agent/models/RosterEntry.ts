import { Effect, Schema } from "effect";

/**
 * What every roster declares about an agent, whatever the roster is written in.
 *
 * The YAML file and the plain object a test hands in are two spellings of one roster, so they share
 * these fields and differ only in where the prompt text comes from — files beside the config, or
 * the object itself. Declaring the shared half once is what keeps a fixture roster and a real one
 * from drifting into two contracts.
 *
 * `tools` carries a decode-side default rather than being merely optional: an agent that names no
 * tools is a real and ordinary agent, and `withDecodingDefaultKey` is what v4 gives instead of
 * `Schema.optionalWith`. The default is an `Effect`, not a thunk.
 */
export const rosterEntryFields = {
  purpose: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  tools: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
};
