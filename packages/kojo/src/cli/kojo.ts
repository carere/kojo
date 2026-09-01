import { Command } from "effect/unstable/cli";
import { thisEngine } from "../contexts/shared/services/resolvePackage.ts";
import { daemon } from "./daemon.ts";
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
export const kojo = root.pipe(
  Command.withSubcommands([init, doctor, run, watch, gate, ui, daemon]),
);

/**
 * What `kojo --version` prints: this package's own `version`, read off its own `package.json`.
 *
 * **Read rather than written down.** It was a literal `"0.0.0"` with a comment saying it must track
 * the package version, and nothing made it — no hook, no test. The first release would have shipped
 * a CLI that reports `0.0.0` for ever, and every release after it. `thisEngine()` already walks up
 * from this file to the nearest manifest, because `doctor` needs the same answer to tell one copy
 * of the engine from two, so there is no new mechanism here and nothing left to keep in step.
 *
 * `unknown` is the honest answer when the walk finds nothing, which cannot happen in an installed
 * package. It is deliberately not a plausible version number: a wrong number that looks right is
 * exactly what this replaced.
 */
export const version = thisEngine()?.version ?? "unknown";
