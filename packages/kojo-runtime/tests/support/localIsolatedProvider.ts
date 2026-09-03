import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedSandboxProvider, type IsolatedSandboxHandle } from "@ai-hero/sandcastle";
import { type SandboxProvider, tagged } from "../../src/contexts/sandbox/models/SandboxProvider.ts";

/**
 * An isolated provider that needs no credentials and no container runtime.
 *
 * Vercel and Daytona are the isolated providers a factory really uses, and neither can run in a
 * test suite: one wants an API token, the other a cloud workspace. But what makes a provider
 * isolated is not where the machine is — it is that Sandcastle may not touch the tree directly and
 * must go through `exec`, `copyIn` and `copyFileOut`. This handle honours exactly that contract
 * against a temporary directory, so Sandcastle takes its **real** isolated path: bundle the repo,
 * copy the bundle in, clone it inside the sandbox, and patch the result back out on close.
 *
 * That makes the suite honest in the one way that matters here. Kojo's side of the boundary — no
 * host path, every file and command through `sandbox.exec` — is exercised end to end, and it is
 * exercised on a laptop with no Docker and on CI with no secrets. What a remote provider adds is
 * latency and a network, not a different sequence of calls.
 *
 * Promises live here because Sandcastle's provider interface is promise-shaped by definition. This
 * is test support, outside the declarations `moon run kojo:check-public-types` grades, and it is the
 * same seam `adapters/boundary.ts` occupies on the other side.
 */

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * One command, through a shell, exactly as a remote provider would run it.
 *
 * A non-zero exit is resolved rather than rejected — the same rule the whole port keeps. `onLine` is
 * fed as output arrives because Sandcastle's provider contract says a batched implementation does
 * not satisfy it.
 */
const shell = (
  command: string,
  cwd: string,
  stdin: string | undefined,
  onLine: ((line: string) => void) | undefined,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (onLine === undefined) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (onLine !== undefined && pending !== "") onLine(pending);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });

const makeHandle = async (): Promise<IsolatedSandboxHandle> => {
  // Everything the sandbox owns lives under one directory that `close` removes. The repo is a
  // child of it rather than the root, because Sandcastle's sync-in replaces the worktree wholesale
  // (`rm -rf … && mv …_clone …`) and needs a parent that survives that.
  const root = await mkdtemp(join(tmpdir(), "kojo-isolated-"));
  const worktreePath = join(root, "repo");

  return {
    worktreePath,
    // The default working directory is the sandbox root, not the worktree: sync-in runs `mktemp`
    // and `git clone` before the worktree exists.
    exec: (command, options) =>
      shell(command, options?.cwd ?? root, options?.stdin, options?.onLine),
    copyIn: async (hostPath, sandboxPath) => {
      await cp(hostPath, sandboxPath, { recursive: true });
    },
    copyFileOut: async (sandboxPath, hostPath) => {
      await cp(sandboxPath, hostPath);
    },
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};

/** The provider, tagged `isolated` — which is what makes `hostPath` `None` on Kojo's side. */
export const localIsolated = (): SandboxProvider =>
  tagged(
    "isolated",
    createIsolatedSandboxProvider({ name: "local-isolated", create: () => makeHandle() }),
  );
