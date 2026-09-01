import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  RunDocument,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type { WorkflowSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { captureWorkflowRevision } from "../../../../src/contexts/workflow/services/captureRevision.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";
import { linkEngine } from "../../../support/linkEngine.ts";

const roots: string[] = [];
const daemons: RunningDaemon[] = [];
const packageRoot = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");

const hostPaths = (): DaemonPaths => {
  const root = mkdtempSync(join(process.cwd(), ".kojo-runner-recovery-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  const paths = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(paths);
  return paths;
};

const project = (root: string, firstCrash: string, completed: string): string => {
  const location = join(root, "project");
  mkdirSync(join(location, ".kojo", "workflows"), { recursive: true });
  linkEngine({ root: location, packageRoot });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ name: "runner-recovery-fixture", private: true, type: "module" }),
  );
  writeFileSync(
    join(location, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: [] }),
  );
  writeFileSync(
    join(location, ".kojo", "workflows", "recover.ts"),
    `import { existsSync, writeFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

export const recover = workflow(
  {
    name: "recover",
    payload: Schema.Null,
    success: Schema.Null,
    error: Schema.Never,
    idempotencyKey: () => "runner-recovery-run",
  },
  () => code(
    {
      name: "crash-once",
      description: "Exit the first Project Runner, then complete in its replacement",
      success: Schema.Null,
      error: Schema.Never,
    },
    Effect.sync(() => {
      if (!existsSync(${JSON.stringify(firstCrash)})) {
        writeFileSync(${JSON.stringify(firstCrash)}, String(process.pid));
        process.exit(42);
      }
      writeFileSync(${JSON.stringify(completed)}, String(process.pid));
      return null;
    }),
  ),
);
`,
  );
  execFileSync("git", ["init", "--initial-branch=main", location]);
  execFileSync("git", ["-C", location, "config", "user.email", "test@kojo.local"]);
  execFileSync("git", ["-C", location, "config", "user.name", "Kojo Test"]);
  execFileSync("git", ["-C", location, "add", "."]);
  execFileSync("git", ["-C", location, "commit", "-m", "test: runner recovery fixture"]);
  return realpathSync(location);
};

const call = (daemon: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost${path}`, {
    unix: daemon.endpoint.socketPath,
    ...init,
  } as RequestInit & { readonly unix: string });

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real Project Runner recovery", () => {
  it("confirms the crashed group stopped and continues the same Run in one replacement", async () => {
    const paths = hostPaths();
    const firstCrash = join(roots[0] ?? "", "first-crash.txt");
    const completed = join(roots[0] ?? "", "completed.txt");
    const location = project(roots[0] ?? "", firstCrash, completed);
    mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
    const captured = captureWorkflowRevision({
      project: location,
      dataRoot: paths.dataRoot,
      workflowName: "recover",
    });
    const databasePath = join(paths.dataRoot, "kojo.db");
    const database = new Database(databasePath, { create: true, strict: true });
    database.run(
      "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
    );
    const projects = new SqliteProjectRepository(database);
    const registered = await Effect.runPromise(
      projects.register({
        requestId: "seed-recovery-project",
        requestBody: "seed-recovery-project",
        dataIdentity: "seed-data",
        location,
        observedAt: "2026-09-01T00:00:00.000Z",
        factory: {
          state: "available",
          refreshState: "current",
          workflows: [
            {
              workflowName: "recover",
              availability: "available",
              source: join(location, ".kojo", "workflows", "recover.ts"),
              revision: captured,
            },
          ],
        },
      }),
    );
    database.close(false);
    chmodSync(databasePath, 0o600);
    const daemon = startDaemon(paths, { automaticRefresh: false, runnerIdleMillis: 50 });
    daemons.push(daemon);
    const response = await call(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/workflows/recover/actions/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "start-recovery",
          dataIdentity: daemon.endpoint.dataIdentity,
          payload: null,
        }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const admitted = (await response.json()) as StartRunResult;
    const deadline = Date.now() + 15_000;
    let run: RunDocument | undefined;
    while (Date.now() < deadline) {
      run = (await (await call(daemon, `/api/v1/runs/${admitted.runId}`)).json()) as RunDocument;
      if (run.state === "succeeded") break;
      await Bun.sleep(25);
    }
    expect(existsSync(firstCrash)).toBe(true);
    expect(run).toMatchObject({ runId: admitted.runId, state: "succeeded" });
    expect(run?.phases).toHaveLength(1);
    const firstPid = Number(readFileSync(firstCrash, "utf8"));
    const replacementPid = Number(readFileSync(completed, "utf8"));
    expect(replacementPid).not.toBe(firstPid);
    expect(() => process.kill(firstPid, 0)).toThrow();

    const beforeRepair = (await (
      await call(daemon, `/api/v1/projects/${registered.project.projectId}/workflows`)
    ).json()) as WorkflowSnapshot;
    const repair = await call(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/actions/repair`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(repair.status, await repair.clone().text()).toBe(202);
    expect(await repair.json()).toMatchObject({ cycle: 2, attempts: 0, state: "recovering" });
    const afterRepair = (await (
      await call(daemon, `/api/v1/projects/${registered.project.projectId}/workflows`)
    ).json()) as WorkflowSnapshot;
    expect(afterRepair.workflows[0]?.activity).toBe(beforeRepair.workflows[0]?.activity);
  }, 30_000);
});
