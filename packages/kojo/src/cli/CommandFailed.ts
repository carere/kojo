import { Console, Effect, Runtime, Schema } from "effect";

/**
 * The command was understood and could not be carried out.
 *
 * Distinct from a parse failure, which the framework rejects before a handler ever runs, and from a
 * storage failure, which is the database saying no. This one is the middle case — a workflow name
 * nothing answers to, a token from another factory, a choice the gate does not offer — and it exists
 * so those exit non-zero. A CLI that printed the problem and exited 0 would be a CLI no script could
 * check.
 *
 * `errorReported` is `false` for the same reason `CliError` sets it: the runtime's automatic report
 * prints a stack trace, and a stack trace is the wrong answer to *you typed a workflow name that
 * does not exist*. The message is printed by {@link commandFailed} instead, and the exit code still
 * comes from the failure.
 */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  message: Schema.String,
}) {
  readonly [Runtime.errorReported] = false;
}

/** Says what is wrong in one line, then fails so the exit code says it too. */
export const commandFailed = (message: string): Effect.Effect<never, CommandFailed> =>
  Effect.andThen(Console.error(`kojo: ${message}`), Effect.fail(new CommandFailed({ message })));
