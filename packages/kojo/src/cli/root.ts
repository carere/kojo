import { Command } from "effect/unstable/cli";

/**
 * The root command, without its subcommands.
 *
 * The Daemon owns its database and selects it from the platform data root. A client cannot select
 * another database or create a second execution owner.
 */
export const root = Command.make("kojo").pipe(
  Command.withDescription("Prepare Factories and control the OS-user Kojo Daemon."),
);
