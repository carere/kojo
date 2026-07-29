import { afterEach, describe, expect, it } from "vitest";
import {
  makeTemporaryDirectory,
  runKojoCli as runCli,
} from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

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
    expect(result.stdout).toBe("No Kojo Projects.\n");
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
        items: [],
        nextCursor: null,
      },
      warnings: [],
    });
    expect(result.stderr).toBe("");
  });

  it("reports connection failure safely on stderr", async () => {
    const directory = await makeTemporaryDirectory("kojo-cli-missing-");
    cleanups.push(directory.cleanup);

    const result = await runCli(["project", "list"], `${directory.path}/missing.sock`);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Kojo Host is unavailable.\nNext: Start the Kojo Host and try again.\n",
    );
    expect(result.stderr).not.toContain(directory);
  });

  it("returns a versioned JSON connection error while keeping diagnostics on stderr", async () => {
    const directory = await makeTemporaryDirectory("kojo-cli-json-missing-");
    cleanups.push(directory.cleanup);

    const result = await runCli(["project", "list", "--json"], `${directory.path}/missing.sock`);

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
        next: "Run: kojo init [path] or kojo project list|show|register|forget",
      },
      warnings: [],
    });
    expect(result.stderr).toBe(
      "Invalid command.\nNext: Run: kojo init [path] or kojo project list|show|register|forget\n",
    );
  });
});
