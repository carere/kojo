import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BindMountSandboxHandle } from "@ai-hero/sandcastle";

/**
 * A bind-mount sandbox handle that needs no container runtime.
 *
 * The sibling of `localIsolatedProvider.ts`, one row up the capability matrix. What makes a sandbox
 * bind-mount is not Docker: it is that Sandcastle reaches the tree through `exec`, `copyFileIn` and
 * `copyFileOut` and that those three land on a filesystem the host can also see. This honours
 * exactly that contract against a temporary directory, so the session-capture path in
 * `contexts/sandbox/adapters/boundary.ts` takes its **real** sequence of calls — locate by `find`,
 * copy out, rewrite, copy back in — on a laptop with no Docker and on CI with no secrets.
 *
 * What a container adds here is a kernel namespace, not a different sequence of calls.
 *
 * Promises live here because Sandcastle's handle interface is promise-shaped by definition. This is
 * test support, outside the declarations `moon run kojo:check-public-types` grades.
 */

/** One command through a shell. A non-zero exit resolves, exactly as every provider's does. */
const shell = (
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
  });

/** A live handle plus the directory that holds everything it owns. */
export interface LocalBindMount {
  readonly handle: BindMountSandboxHandle;
  /** The sandbox's own root on the host. Every "sandbox path" in a test is built from this. */
  readonly root: string;
}

export const localBindMount = async (): Promise<LocalBindMount> => {
  const root = await mkdtemp(join(tmpdir(), "kojo-bind-mount-"));
  const worktreePath = join(root, "repo");
  await mkdir(worktreePath, { recursive: true });

  return {
    root,
    handle: {
      worktreePath,
      exec: (command, options) => shell(command, options?.cwd ?? worktreePath),
      copyFileIn: async (hostPath, sandboxPath) => {
        await mkdir(dirname(sandboxPath), { recursive: true });
        await cp(hostPath, sandboxPath);
      },
      copyFileOut: async (sandboxPath, hostPath) => {
        await mkdir(dirname(hostPath), { recursive: true });
        await cp(sandboxPath, hostPath);
      },
      close: async () => {
        await rm(root, { recursive: true, force: true });
      },
    },
  };
};
