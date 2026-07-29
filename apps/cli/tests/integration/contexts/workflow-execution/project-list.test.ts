import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startKojoHostProcess } from "@kojo/test-support";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("kojo project list", () => {
  it("shows Host connectivity and the empty Project state to a person", async () => {
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const result = await runCli(["project", "list"], host.socketPath);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Kojo Host 0.1.0 (protocol 1.0)\nNo Kojo Projects.\n");
    expect(result.stderr).toBe("");
  });

  it("keeps versioned JSON on stdout and diagnostics off stdout", async () => {
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const result = await runCli(["project", "list", "--json"], host.socketPath);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "project.list",
      result: {
        host: {
          protocol: { major: 1, minor: 0 },
          hostVersion: "0.1.0",
          capabilities: ["projects:list"],
        },
        projects: [],
      },
      warnings: [],
    });
    expect(result.stderr).toBe("");
  });

  it("reports connection failure safely on stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kojo-cli-missing-"));
    cleanups.push(() => rm(directory, { recursive: true }));

    const result = await runCli(["project", "list"], join(directory, "missing.sock"));

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Kojo Host is unavailable.\nNext: Start the Kojo Host and try again.\n",
    );
    expect(result.stderr).not.toContain(directory);
  });

  it("returns a versioned JSON connection error while keeping diagnostics on stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kojo-cli-json-missing-"));
    cleanups.push(() => rm(directory, { recursive: true }));

    const result = await runCli(["project", "list", "--json"], join(directory, "missing.sock"));

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "project.list",
      error: {
        code: "host-unavailable",
        message: "Kojo Host is unavailable.",
        next: "Start the Kojo Host and try again.",
      },
      warnings: [],
    });
    expect(result.stderr).toBe(
      "Kojo Host is unavailable.\nNext: Start the Kojo Host and try again.\n",
    );
  });

  it("returns a versioned JSON error for invalid syntax", async () => {
    const result = await runCli(["unknown", "--json"], "/unused/kojo.sock");

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "unknown",
      error: {
        code: "invalid-command",
        message: "Invalid command.",
        next: "Run: kojo project list [--json]",
      },
      warnings: [],
    });
    expect(result.stderr).toBe("Invalid command.\nNext: Run: kojo project list [--json]\n");
  });
});

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
