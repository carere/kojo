import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface KojoCliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export const runKojoCli = async (
  args: ReadonlyArray<string>,
  socketPath: string,
  cwd = workspaceRoot,
): Promise<KojoCliResult> => {
  const child = Bun.spawn(["bun", "run", join(workspaceRoot, "apps/cli/main.ts"), ...args], {
    cwd,
    env: { ...process.env, KOJO_HOST_SOCKET: socketPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

export const makeTemporaryDirectory = async (prefix: string) => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true }) } as const;
};
