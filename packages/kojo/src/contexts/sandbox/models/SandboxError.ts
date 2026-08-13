import { Schema } from "effect";

/**
 * Which part of the sandbox lifecycle refused. Named, because the trace groups on it.
 *
 * `agent` is the fourth because an agent invocation is a lifecycle step of its own and not an
 * `exec`: it is Sandcastle's `run`, it has its own idle timeout, its own session transfer and its
 * own stream parser, and every one of those fails in a way `exec` cannot. A reader who sees `exec`
 * goes and looks at a command line; there is no command line here.
 */
export const SandboxOperation = Schema.Literals(["create", "exec", "close", "agent"]);
export type SandboxOperation = typeof SandboxOperation.Type;

/**
 * The sandbox itself failed — the container never started, the command never ran, the teardown
 * never finished.
 *
 * A `Schema.TaggedError` rather than a plain one, because this error travels a workflow error
 * channel, and the engine persists what it records.
 *
 * `close` is in the operation set even though release is `orDie`. The defect a failed teardown
 * raises carries this error as its payload, so the crash report names the branch and the reason
 * instead of showing a bare rejection from inside Sandcastle.
 *
 * Note what is **not** an error here, exactly as in `WorkspaceError`: a command that ran and exited
 * non-zero. Sandcastle's `exec` surfaces the code in its result, and so does this boundary.
 */
export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  operation: SandboxOperation,
  /** The branch for a lifecycle failure, the command line for an `exec` one. */
  target: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}
