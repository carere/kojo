import { Schema } from "effect";

const ExecResultBase: Schema.Class<
  ExecResult,
  Schema.Struct<{
    readonly argv: Schema.$Array<Schema.String>;
    readonly exitCode: Schema.Finite;
    readonly stdout: Schema.String;
    readonly stderr: Schema.String;
  }>,
  Record<never, never>
> = Schema.Class<ExecResult>("ExecResult")({
  /** The command as it was asked for, so a record of the result names what produced it. */
  argv: Schema.Array(Schema.String),
  exitCode: Schema.Finite,
  stdout: Schema.String,
  stderr: Schema.String,
});

/**
 * What one command left behind.
 *
 * **A non-zero exit code is a value, not an exception.** Sandcastle's `exec` surfaces the code in
 * its result rather than throwing, and this port keeps that shape: `bun test` exiting 1 is the
 * answer a check asked for, not a fault the adapter should hide in an error channel. Only the
 * adapter decides what becomes a `WorkspaceError` — and it decides that for a command that never
 * ran, never for one that ran and disagreed.
 */
export class ExecResult extends ExecResultBase {
  get succeeded(): boolean {
    return this.exitCode === 0;
  }
}
