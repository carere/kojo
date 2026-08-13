import { Command } from "effect/unstable/cli";
import { doctor } from "./doctor.ts";
import { gate } from "./gate.ts";
import { init } from "./init.ts";
import { root } from "./root.ts";
import { run } from "./run.ts";
import { ui } from "./ui.ts";
import { watch } from "./watch.ts";

/**
 * The whole command tree.
 *
 * The root and its shared flags live in `root.ts` so a subcommand can read them without importing
 * this module — the handlers do `yield* root`, and building the tree here keeps that from being an
 * import cycle.
 */
export const kojo = root.pipe(Command.withSubcommands([init, doctor, run, watch, gate, ui]));

/**
 * Kept beside the command because `Command.run` requires it. It must track the package version;
 * there is no import of `package.json` here because JSON module resolution is off repo-wide.
 */
export const version = "0.0.0";
