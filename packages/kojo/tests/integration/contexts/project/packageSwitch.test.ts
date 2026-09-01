import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  type ProjectRunnerHandle,
  ProjectRunnerSupervisor,
} from "../../../../src/contexts/project/services/ProjectRunnerSupervisor.ts";

const roots: string[] = [];

const processHandle = async (
  graph: string,
  journal: string,
): Promise<ProjectRunnerHandle & { readonly pid: number }> => {
  const instanceId = crypto.randomUUID();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-install",
      "--no-env-file",
      "-e",
      `
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(journal)}, "started:${graph}\\n");
        process.on("SIGTERM", () => {
          fs.appendFileSync(${JSON.stringify(journal)}, "stopped:${graph}\\n");
          process.exit(0);
        });
        await new Promise(() => {});
      `,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  while (!readFileSync(journal, "utf8").includes(`started:${graph}`)) await Bun.sleep(5);
  let stopping: Promise<void> | undefined;
  return {
    instanceId,
    packageGraphId: graph,
    purpose: "execution",
    pid: child.pid,
    stop: () => {
      stopping ??= (async () => {
        child.kill("SIGTERM");
        const exit = await child.exited;
        if (exit !== 0) throw new Error(`controlled Project Runner exited ${exit}`);
      })();
      return stopping;
    },
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Project Runner package switching", () => {
  it("stops polling and confirms the old process before it loads the selected graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-package-switch-"));
    roots.push(root);
    const journal = join(root, "events.txt");
    appendFileSync(journal, "");
    const supervisor = new ProjectRunnerSupervisor();
    const first = await processHandle("graph-a", journal);
    await supervisor.attach("project-a", first);

    const loaded = await supervisor.prepare({
      projectId: "project-a",
      packageGraphId: "graph-b",
      stopCurrentPolling: async () => appendFileSync(journal, "polling-stopped\n"),
      load: async () => {
        expect(() => process.kill(first.pid, 0)).toThrow();
        appendFileSync(journal, "loaded:graph-b\n");
        return "prepared-b";
      },
    });
    expect(loaded).toBe("prepared-b");
    expect(readFileSync(journal, "utf8").trim().split("\n")).toEqual([
      "started:graph-a",
      "polling-stopped",
      "stopped:graph-a",
      "loaded:graph-b",
    ]);

    const second = await processHandle("graph-b", journal);
    await supervisor.attach("project-a", second);
    expect(supervisor.currentGraph("project-a")).toBe("graph-b");
    await supervisor.shutdown();
    expect(() => process.kill(second.pid, 0)).toThrow();
  });
});
