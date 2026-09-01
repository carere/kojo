import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  ExecuteRegisteredRequest,
  ExecuteRegisteredResult,
} from "../../../../src/runner/main.ts";

const runner = fileURLToPath(new URL("../../../../src/runner/main.ts", import.meta.url));
const executionRoot = fileURLToPath(new URL("../../../fixtures/runner", import.meta.url));

const execute = async (
  request: ExecuteRegisteredRequest,
  counter: string,
): Promise<ExecuteRegisteredResult> => {
  const child = Bun.spawn([process.execPath, runner, "execute"], {
    cwd: executionRoot,
    env: { ...process.env, KOJO_EFFECT_COUNTER: counter },
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`Runner exited ${exit}: ${error}`);
  return JSON.parse(output) as ExecuteRegisteredResult;
};

describe("fresh Project Runner replay", () => {
  it("keeps the Daemon Run ID and does not repeat a committed code Phase", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kojo-runner-replay-"));
    const counter = join(directory, "effects.txt");
    writeFileSync(counter, "");
    try {
      const base: ExecuteRegisteredRequest = {
        registrationVersion: 1,
        selectedProtocol: 1,
        daemonInstanceId: "daemon-1",
        runnerInstanceId: "runner-1",
        projectId: "project-1",
        boundProjectId: "project-1",
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        boundPackageGraphId: "b".repeat(64),
        executionRoot,
        workflowName: "example",
        entrySource: "example.ts",
        payload: null,
        connectionSecret: "s".repeat(32),
        runId: "daemon-assigned-run",
        recordedResults: {},
      };
      const first = await execute(base, counter);
      expect(first.outcome).toBe("succeeded");
      expect(first.runId).toBe("daemon-assigned-run");
      expect(Object.keys(first.recordedResults).length).toBeGreaterThan(0);

      const second = await execute(
        { ...base, runnerInstanceId: "runner-2", recordedResults: first.recordedResults },
        counter,
      );
      expect(second.outcome).toBe("succeeded");
      expect(second.runId).toBe("daemon-assigned-run");
      expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["effect"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
