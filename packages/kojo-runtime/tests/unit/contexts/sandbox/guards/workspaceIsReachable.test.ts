import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import {
  workspaceIsReachable,
  workspaceProbe,
} from "../../../../../src/contexts/sandbox/guards/workspaceIsReachable.ts";
import { ExecResult } from "../../../../../src/contexts/sandbox/models/ExecResult.ts";
import { SandboxError } from "../../../../../src/contexts/sandbox/models/SandboxError.ts";

/**
 * The two failures this reading has to recognise, in the words they were measured in.
 *
 * Both strings below were taken from a real provider on this machine rather than written from
 * memory, which is the whole reason the reading is a pure function separated from the sandbox that
 * produces it: an assertion against a container runtime's exact sentence should not need a container
 * runtime. If either upstream ever changes its wording, what fails is this file — cheaply, and
 * naming what changed — rather than a lane that stops resuming.
 */

const ran = (options: {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}) =>
  Result.succeed(
    new ExecResult({
      argv: [workspaceProbe],
      exitCode: options.exitCode,
      stdout: options.stdout ?? "",
      stderr: options.stderr ?? "",
    }),
  );

const neverRan = (reason: string) =>
  Result.fail(
    new SandboxError({
      operation: "exec",
      target: workspaceProbe,
      reason,
      cause: undefined,
    }),
  );

describe("reading whether a sandbox can work where the run needs it to", () => {
  it("takes a command that ran and exited zero as the workspace being there", () => {
    const reach = workspaceIsReachable(ran({ exitCode: 0, stdout: "/home/agent/workspace\n" }));

    expect(reach.reached).toBe(true);
    expect(reach.probe).toBe(workspaceProbe);
    // The path is kept and never compared. Where a workspace lives is the provider's business, and
    // an isolated one puts it somewhere no bind mount ever would.
    expect(reach.detail).toBe("/home/agent/workspace");
  });

  it("takes Docker's exit 127 as the workspace being gone, whatever the message says", () => {
    // Measured, verbatim, on Docker Desktop 29.4.0: the container runtime's own words, and they
    // arrive on **stdout**. This is the sentence a run used to fail with, wrapped in
    // `AgentInvocationError{fault: "provider-failed"}` and naming neither the branch nor the tree.
    const oci =
      'OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("/home/agent/workspace") set in config.json failed: no such file or directory';

    const reach = workspaceIsReachable(ran({ exitCode: 127, stdout: `${oci}\n` }));

    expect(reach.reached).toBe(false);
    expect(reach.detail).toBe(`exit 127 — ${oci}`);
  });

  it("takes a command that never ran as the same fact, not as a different one", () => {
    // Measured on `no-sandbox`, where there is no container to report anything: the spawn itself
    // fails, so this arrives on the **error** channel rather than as an exit code. One fault, two
    // shapes, and a reading that only knew about exit codes would let this one through.
    const reach = workspaceIsReachable(
      neverRan("exec failed: ENOENT: no such file or directory, posix_spawn 'sh'"),
    );

    expect(reach.reached).toBe(false);
    expect(reach.detail).toBe(
      "the command never ran — exec failed: ENOENT: no such file or directory, posix_spawn 'sh'",
    );
  });

  it("reads a plain non-zero exit with nothing on stdout out of stderr instead", () => {
    const reach = workspaceIsReachable(ran({ exitCode: 1, stderr: "  cannot chdir\n" }));

    expect(reach.reached).toBe(false);
    expect(reach.detail).toBe("exit 1 — cannot chdir");
  });

  it("keeps one line, because the detail is carried on a persisted error", () => {
    const reach = workspaceIsReachable(
      ran({ exitCode: 127, stdout: "\n\nfirst line\nsecond line\n" }),
    );

    expect(reach.detail).toBe("exit 127 — first line");
  });
});
