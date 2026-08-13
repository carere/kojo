import { Schema } from "effect";

/**
 * A human was asked and said no.
 *
 * A rejection is a verdict, not a fault: nothing malfunctioned, and the run must not read as broken
 * in the trace. It is an error because it ends the branch of the workflow that assumed approval.
 *
 * `reason` is the reviewer's own words. A rejected fix is re-prompted from it, so an empty reason
 * costs the next attempt its only clue.
 */
export class GateRejected extends Schema.TaggedError<GateRejected>()("GateRejected", {
  gate: Schema.String,
  /** Who was asked to decide. */
  actor: Schema.String,
  reason: Schema.String,
}) {}
