import { Schema, type SchemaError, SchemaIssue } from "effect";

/** Built once: the formatter walks the tree and accumulates `Pointer` paths, so we do not. */
const toStandardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * One decode fault, with the path that produced it.
 *
 * A decode failure has to survive being persisted and read back — the correction prompt is written
 * from it, and the trace shows it long after the process that decoded is gone. `SchemaError` itself
 * cannot: it is a `Data.TaggedError`, and its `SchemaIssue.Issue` tree carries AST nodes and the
 * raw input, neither of which is a schema or JSON. So the tree is flattened here to the part that
 * is load-bearing — **which field**, and **what was wrong with it** — one entry per leaf fault.
 *
 * The path is what makes this worth more than a rendered string: feedback that names
 * `changedFiles.0` sends an agent to the field, and feedback that says "invalid input" sends it
 * back to guessing.
 */
export class DecodeIssue extends Schema.Class<DecodeIssue>("DecodeIssue")({
  /** One key per level, outermost first. Empty when the fault is the whole value. */
  path: Schema.Array(Schema.String),
  message: Schema.String,
}) {
  static fromSchemaError(error: SchemaError.SchemaError): ReadonlyArray<DecodeIssue> {
    return toStandardIssues(error.issue).issues.map(
      (issue) =>
        new DecodeIssue({
          path: (issue.path ?? []).map((segment) =>
            String(typeof segment === "object" ? segment.key : segment),
          ),
          message: issue.message,
        }),
    );
  }
}
