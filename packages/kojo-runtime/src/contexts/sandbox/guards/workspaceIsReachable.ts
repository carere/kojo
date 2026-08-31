import { Result } from "effect";
import type { ExecResult } from "../models/ExecResult.ts";
import type { SandboxError } from "../models/SandboxError.ts";
import { WorkspaceReach } from "../models/WorkspaceReach.ts";

/**
 * The command that asks a sandbox whether it can work where the run needs it to.
 *
 * `pwd` and nothing more. It is a shell builtin, so no image can be missing it — `kojo-test:sandbox`
 * carries no git for exactly this reason, and a probe that needed a binary would be a probe that
 * fails for a second, unrelated reason. What matters is not the output: it is that the command runs
 * **at all**, because resolving the working directory is the step that fails.
 */
export const workspaceProbe = "pwd";

/** The first line with something on it, which is where both measured failures put their message. */
const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/**
 * Read one probe as *the workspace is there* or *it is not*.
 *
 * Pure, and separate from the sandbox that produced it, because the two failures this has to
 * recognise are exact strings measured on real providers and a test should be able to hand them over
 * without a container:
 *
 * - **Docker, bind mount.** The command runs and exits **127**, and the container runtime's own
 *   words arrive on stdout: `OCI runtime exec failed: … chdir to cwd ("/home/agent/workspace") set
 *   in config.json failed: no such file or directory`.
 * - **`no-sandbox`.** The command never runs at all. Spawning it fails with
 *   `ENOENT: no such file or directory, posix_spawn 'sh'`, so it arrives on the **error** channel as
 *   a `SandboxError` rather than as an exit code.
 *
 * Both shapes are one fact — the working directory could not be resolved — and treating either of
 * them as an ordinary command result is how a run ends up reporting OCI runtime internals to a human
 * who asked it to review a diff.
 *
 * Note what is deliberately *not* read: the output. A workspace that answers a path is reachable
 * whatever the path is, because the provider decides where the workspace lives and comparing against
 * a guess would fail every isolated provider.
 */
export const workspaceIsReachable = (
  outcome: Result.Result<ExecResult, SandboxError>,
): WorkspaceReach =>
  Result.isFailure(outcome)
    ? new WorkspaceReach({
        probe: workspaceProbe,
        reached: false,
        detail: `the command never ran — ${firstLine(outcome.failure.reason)}`,
      })
    : new WorkspaceReach({
        probe: workspaceProbe,
        reached: outcome.success.succeeded,
        detail: outcome.success.succeeded
          ? firstLine(outcome.success.stdout)
          : `exit ${outcome.success.exitCode} — ${firstLine(`${outcome.success.stdout}\n${outcome.success.stderr}`)}`,
      });
