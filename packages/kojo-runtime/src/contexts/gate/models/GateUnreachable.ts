import { Schema } from "effect";

/**
 * Nobody could be asked.
 *
 * Distinct from `GateRejected` and `GateExpired`, which are answers: this one says the requesting
 * half never got out — Slack refused the post, the review API returned 500, the terminal was gone.
 * A run that cannot ask must fail loudly rather than suspend on a question no human will ever see.
 */
export class GateUnreachable extends Schema.TaggedError<GateUnreachable>()("GateUnreachable", {
  gate: Schema.String,
  /** Who could not be reached. */
  actor: Schema.String,
  reason: Schema.String,
}) {}
