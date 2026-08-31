import { Schema, type SchemaError } from "effect";
import { DecodeIssue } from "../../shared/models/DecodeIssue.ts";

/**
 * Why an event did not become a run, or why a run could not be reported back.
 *
 * Named rather than one message, because a watcher answers the four very differently. `unreachable`
 * is retried — the tracker is down, and it will come back. `malformed` and `key-mismatch` are a
 * human's mistake in the factory and retrying repeats it forever. `ack-refused` is the awkward one:
 * the run genuinely happened, and only the telling failed, so nothing may re-start the run on the
 * strength of it.
 */
export const TriggerFault = Schema.Literals([
  /** The source could not be read — the API refused, the socket died, the file is gone. */
  "unreachable",
  /** An event arrived whose payload is not one this workflow takes. */
  "malformed",
  /** The event names a dedup value the workflow does not agree with. */
  "key-mismatch",
  /** The run happened; telling the source about it did not. */
  "ack-refused",
]);
export type TriggerFault = typeof TriggerFault.Type;

/**
 * The trigger could not do what it was asked.
 *
 * A `Schema.TaggedError` for the same reason the other port errors are: it travels an error channel
 * the engine persists, and a watcher that reports a fault has to report the same value the trace
 * stored.
 *
 * `issues` is why decoding an event's payload is worth more than a `JSON.parse`: a webhook body with
 * a missing field reports **which key** — `ticket.revision` — rather than "invalid payload", and it
 * reports it before a single sandbox is built.
 */
export class TriggerError extends Schema.TaggedError<TriggerError>()("TriggerError", {
  /** The trigger this is about, as the event named it. */
  source: Schema.String,
  fault: TriggerFault,
  /** The dedup value this is about, when it is about one event rather than the whole source. */
  key: Schema.optional(Schema.String),
  reason: Schema.String,
  /** One entry per path that is wrong. Empty unless the fault is `malformed`. */
  issues: Schema.Array(DecodeIssue),
  cause: Schema.Defect(),
}) {
  static fromSchemaError(
    options: { readonly source: string; readonly key: string },
    error: SchemaError.SchemaError,
  ): TriggerError {
    const issues = DecodeIssue.fromSchemaError(error);
    return new TriggerError({
      source: options.source,
      fault: "malformed",
      key: options.key,
      reason: issues.map(TriggerError.describe).join("; "),
      issues,
      cause: undefined,
    });
  }

  /** `ticket.revision: Expected string`. The path first, because the path is the answer. */
  static describe(issue: DecodeIssue): string {
    return issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`;
  }
}
