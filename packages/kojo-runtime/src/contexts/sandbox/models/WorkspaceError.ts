import { Schema } from "effect";

/** Which part of the workspace refused. Named, because the trace groups on it. */
export const WorkspaceOperation = Schema.Literals(["read", "write", "stat", "unlink", "exec"]);
export type WorkspaceOperation = typeof WorkspaceOperation.Type;

/**
 * The workspace could not do what it was asked.
 *
 * A `Schema.TaggedError` rather than a plain one, because this error travels a workflow error
 * channel, and the engine persists what it records.
 *
 * Note what is **not** an error here: a command that ran and exited non-zero. That is an
 * `ExecResult` with a non-zero `exitCode` — the whole point of a check is to read it. A
 * `WorkspaceError` means the workspace itself failed: the file is missing, the path escapes the
 * root, the binary could not be spawned.
 */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  operation: WorkspaceOperation,
  /** The path or the command line the caller asked for, as the caller wrote it. */
  target: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}
