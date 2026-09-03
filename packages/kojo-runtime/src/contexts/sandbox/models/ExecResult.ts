import { Schema } from "effect";

/**
 * What one command left behind.
 *
 * **A non-zero exit code is a value, not an exception.** Sandcastle's `exec` surfaces the code in
 * its result rather than throwing, and this port keeps that shape: `bun test` exiting 1 is the
 * answer a check asked for, not a fault the adapter should hide in an error channel. Only the
 * adapter decides what becomes a `WorkspaceError` — and it decides that for a command that never
 * ran, never for one that ran and disagreed.
 */
export class ExecResult extends Schema.Class<ExecResult>("ExecResult")({
  /** The command as it was asked for, so a record of the result names what produced it. */
  argv: Schema.Array(Schema.String),
  exitCode: Schema.Finite,
  stdout: Schema.String,
  stderr: Schema.String,
}) {
  get succeeded(): boolean {
    return this.exitCode === 0;
  }
}
