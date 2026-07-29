import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("kojo project list", () => {
  it("shows Host readiness and the empty Project state to a person", async () => {
    const { socketPath } = await startTemporaryHost();

    const result = await runCli(["project", "list"], socketPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Kojo Host 0.1.0 (protocol 1.0)\nNo Kojo Projects.\n");
    expect(result.stderr).toBe("");
  });

  it("keeps versioned JSON on stdout and diagnostics off stdout", async () => {
    const { socketPath } = await startTemporaryHost();

    const result = await runCli(["project", "list", "--json"], socketPath);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      command: "project.list",
      data: {
        host: {
          protocol: { major: 1, minor: 0 },
          hostVersion: "0.1.0",
          capabilities: ["projects:list"],
        },
        projects: [],
      },
    });
    expect(result.stderr).toBe("");
  });

  it("reports connection failure safely on stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kojo-cli-missing-"));
    cleanups.push(() => rm(directory, { recursive: true }));

    const result = await runCli(["project", "list", "--json"], join(directory, "missing.sock"));

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Kojo Host is unavailable.\n");
    expect(result.stderr).not.toContain(directory);
  });
});

const startTemporaryHost = async () => {
  const directory = await mkdtemp(join(tmpdir(), "kojo-cli-host-"));
  const socketPath = join(directory, "host.sock");
  const server = Bun.spawn(["bun", "run", "../host/main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, KOJO_HOST_SOCKET: socketPath },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 50 && !(await Bun.file(socketPath).exists()); attempt += 1) {
    await Bun.sleep(10);
  }
  cleanups.push(async () => {
    server.kill("SIGTERM");
    await server.exited;
    await rm(directory, { recursive: true });
  });
  return { socketPath };
};

const runCli = async (args: ReadonlyArray<string>, socketPath: string) => {
  const child = Bun.spawn(["bun", "run", "main.ts", ...args], {
    cwd: process.cwd(),
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
