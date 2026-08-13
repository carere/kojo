import { Schema } from "effect";

/** Which question the trace could not answer. Named, because the Console shows three surfaces. */
export const TraceReadOperation = Schema.Literals([
  /** The run list. */
  "runs",
  /** One whole run document. */
  "run",
  /** One phase's occurrences, from a cursor. */
  "occurrences",
]);
export type TraceReadOperation = typeof TraceReadOperation.Type;

/**
 * The trace could not be read, or what came back was not what the schema says it is.
 *
 * One error for both, deliberately. A driver that could not open the file and a row whose
 * `on_expiry` names a fourth branch are the same fact to a reader: **this surface cannot be
 * trusted right now**. Splitting them would push the choice of which to catch onto every caller,
 * and the Console does the same thing with either — it keeps the last data on screen and says it
 * is retrying.
 *
 * A missing *run* is not one of these. Asking for a run that does not exist is an ordinary answer —
 * `None` — because the Console's route is a URL a person pasted, and a typo is not a fault of the
 * trace. This is what makes a read error rare enough to be loud.
 */
export class TraceReadError extends Schema.TaggedError<TraceReadError>()("TraceReadError", {
  operation: TraceReadOperation,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}
