import { Command, Flag } from "effect/unstable/cli";

/** Where a factory keeps its durable state when nobody says otherwise. */
export const defaultDatabase = ".kojo/kojo.db";

/**
 * The root command, without its subcommands.
 *
 * Split from `kojo.ts` so a subcommand can read the shared flags — a handler reads them with
 * `yield* root` — without importing the module that attaches it. Building the whole tree in one file
 * would make that import a cycle.
 *
 * **`withSharedFlags`, not a flag in the command's own config.** A flag declared the ordinary way
 * lands in this command's input and is invisible to every child, so `kojo gate answer --database x`
 * would be an unknown-flag error. Shared flags are also accepted on either side of the subcommand
 * name, which is what a person types.
 *
 * Five flag names are already the framework's and must not be redeclared: `--help`/`-h`,
 * `--version`/`-v`, `--wizard`, `--completions`, `--log-level`. Note that `-v` is version rather
 * than verbose.
 */
export const root = Command.make("kojo").pipe(
  Command.withDescription(
    "Build a software factory: Effect workflows driving AI coding agents in sandboxes.",
  ),
  Command.withSharedFlags({
    database: Flag.string("database").pipe(
      Flag.withDescription(
        "The SQLite file the engine suspends into and the askings are written to",
      ),
      Flag.withDefault(defaultDatabase),
    ),
  }),
);
