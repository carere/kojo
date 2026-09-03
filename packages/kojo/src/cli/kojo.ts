import { Command } from "effect/unstable/cli";
import { retry, status } from "../contexts/daemon/adapters/ClientRequestCommand.ts";
import { daemon } from "../contexts/daemon/adapters/DaemonCommand.ts";
import { ui } from "../contexts/daemon/adapters/UiCommand.ts";
import { gate } from "../contexts/gate/adapters/GateCommand.ts";
import { project } from "../contexts/project/adapters/ProjectCommand.ts";
import { doctor } from "../contexts/scaffold/adapters/DoctorCommand.ts";
import { init } from "../contexts/scaffold/adapters/InitCommand.ts";
import { thisEngine } from "../contexts/shared/services/resolvePackage.ts";
import { run } from "../contexts/workflow/adapters/RunCommand.ts";
import { workflow } from "../contexts/workflow/adapters/WorkflowCommand.ts";
import { root } from "./root.ts";

/**
 * The whole command tree.
 *
 * Repository-local authoring commands do not start execution. Runtime commands are clients of the
 * one OS-user Daemon.
 */
export const kojo = root.pipe(
  Command.withSubcommands([init, doctor, status, retry, run, gate, ui, daemon, project, workflow]),
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
