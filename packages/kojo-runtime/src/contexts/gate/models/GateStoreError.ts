import { Schema } from "effect";

/** Which half of the store failed. Named, because the three are answered very differently. */
export const GateStoreOperation = Schema.Literals([
  /** Writing the row that says a human was asked. */
  "ask",
  /** Writing the verdict beside the asking it answers. */
  "record",
  /** Writing down that the deadline settled the asking, so the queue stops listing it as waiting. */
  "expire",
  /** Reading the askings back. */
  "read",
]);
export type GateStoreOperation = typeof GateStoreOperation.Type;

/**
 * The askings could not be written down or read back.
 *
 * Distinct from every other gate error, and the distinction is the point: `GateUnreachable` says
 * nobody could be asked, `GateRejected` and `GateExpired` are answers. This one says the *question
 * survived* — or would have — but the surface that lists open questions cannot be trusted right
 * now. A failed `ask` becomes `GateUnreachable` at the port boundary, because a run that cannot
 * record its own question must not suspend on one nobody will ever be shown.
 *
 * A `Schema.TaggedError` rather than a plain one, because the engine persists what it records and a
 * failed ask reaches a workflow error channel through the gate.
 */
export class GateStoreError extends Schema.TaggedError<GateStoreError>()("GateStoreError", {
  operation: GateStoreOperation,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}
