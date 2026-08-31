import { Schema, type SchemaError } from "effect";
import { DecodeIssue } from "../../shared/models/DecodeIssue.ts";

/**
 * Why a roster did not produce an agent. Named, because the four are answered very differently.
 *
 * The first three are load faults: they are found once, before anything spawns, and they are a
 * human's mistake in the factory rather than anything a run can recover from. The fourth is a
 * lookup fault, and it means a workflow calls an agent this roster does not define.
 */
export const RosterFault = Schema.Literals([
  /** The roster itself could not be read — no such file, no permission. */
  "unreadable",
  /** The roster was read and is not a roster: the YAML does not parse, or an entry does not decode. */
  "malformed",
  /** The roster names an agent whose prompt files are not there. */
  "no-prompt",
  /** Nothing in this roster answers to that name. */
  "unknown-agent",
]);
export type RosterFault = typeof RosterFault.Type;

/**
 * The roster could not answer.
 *
 * A `Schema.TaggedError`, because an `unknown-agent` reaches a workflow error channel and the
 * engine persists what it records.
 *
 * `issues` is the reason this error is worth more than a message: a malformed roster reports
 * **which key** is wrong — `agents.scout.model` — rather than "invalid config". That is the whole
 * point of decoding the roster through `Schema` instead of reading a parsed object by hand, and it
 * arrives at load, before a single sandbox is built.
 */
export class RosterError extends Schema.TaggedError<RosterError>()("RosterError", {
  /** The roster this is about — a file path, or the name an object roster was given. */
  source: Schema.String,
  fault: RosterFault,
  /** The agent this is about, when it is about one rather than the whole roster. */
  agent: Schema.optional(Schema.String),
  reason: Schema.String,
  /** One entry per path that is wrong. Empty unless the fault is `malformed`. */
  issues: Schema.Array(DecodeIssue),
  cause: Schema.Defect(),
}) {
  static fromSchemaError(
    options: { readonly source: string },
    error: SchemaError.SchemaError,
  ): RosterError {
    const issues = DecodeIssue.fromSchemaError(error);
    return new RosterError({
      source: options.source,
      fault: "malformed",
      reason: issues.map(RosterError.describe).join("; "),
      issues,
      cause: undefined,
    });
  }

  /** `agents.scout.model: Expected string`. The path first, because the path is the answer. */
  static describe(issue: DecodeIssue): string {
    return issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`;
  }
}
