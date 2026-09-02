import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CancelRunResult,
  RunDocument,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
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

const paths = (): DaemonPaths => {
  const root = mkdtempSync(join(process.cwd(), ".kojo-forced-stop-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  const value = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(value);
  return value;
};

const project = (root: string, evidence: string): string => {
  const location = join(root, "project");
  mkdirSync(join(location, ".kojo", "workflows"), { recursive: true });
  linkEngine({ root: location, packageRoot });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ name: "forced-stop-fixture", private: true, type: "module" }),
  );
  writeFileSync(
    join(location, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: [] }),
  );
  writeFileSync(
    join(location, ".kojo", "workflows", "blocked.ts"),
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

export const blocked = workflow(
  {
    name: "blocked",
    payload: Schema.Null,
    success: Schema.Null,
    error: Schema.Never,
    idempotencyKey: () => "blocked-run",
  },
  () => code(
    {
      name: "uncooperative-effect",
      description: "Create evidence and block the Runner event loop",
      success: Schema.Null,
      error: Schema.Never,
    },
    Effect.sync(() => {
      const child = spawn("/bin/sleep", ["60"]);
      writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ runnerPid: process.pid, childPid: child.pid }));
      const until = Date.now() + 60_000;
      while (Date.now() < until) { /* controlled non-cooperative fixture */ }
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
  execFileSync("git", ["-C", location, "commit", "-m", "test: forced stop fixture"]);
  return realpathSync(location);
};

const call = (daemon: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost${path}`, {
    unix: daemon.endpoint.socketPath,
    ...init,
  } as RequestInit & { readonly unix: string });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real Project Runner cancellation", () => {
  it("force-stops the owned process group after the cooperative deadline and confirms before reply", async () => {
    const hostPaths = paths();
    const evidence = join(roots[0] ?? "", "effect-evidence.json");
    const location = project(roots[0] ?? "", evidence);
    mkdirSync(hostPaths.dataRoot, { recursive: true, mode: 0o700 });
    const captured = captureWorkflowRevision({
      project: location,
      dataRoot: hostPaths.dataRoot,
      workflowName: "blocked",
    });
    const databasePath = join(hostPaths.dataRoot, "kojo.db");
    const database = new Database(databasePath, { create: true, strict: true });
    database.run(
      "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
    );
    const projects = new SqliteProjectRepository(database);
    const registered = await Effect.runPromise(
      projects.register({
        requestId: "seed-forced-stop-project",
        requestBody: "seed-forced-stop-project",
        dataIdentity: "seed-data",
        location,
        observedAt: "2026-09-01T00:00:00.000Z",
        factory: {
          state: "available",
          refreshState: "current",
          workflows: [
            {
              workflowName: "blocked",
              availability: "available",
              source: join(location, ".kojo", "workflows", "blocked.ts"),
              revision: captured,
            },
          ],
        },
      }),
    );
    database.close(false);
    chmodSync(databasePath, 0o600);
    const daemon = startDaemon(hostPaths, {
      automaticRefresh: false,
      runnerCleanupMillis: 50,
      runnerIdleMillis: 50,
    });
    daemons.push(daemon);
    const projectId = registered.project.projectId;
    const start = await call(
      daemon,
      `/api/v1/projects/${projectId}/workflows/blocked/actions/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "start-blocked",
          dataIdentity: daemon.endpoint.dataIdentity,
          payload: null,
        }),
      },
    );
    expect(start.status, await start.clone().text()).toBe(202);
    const admitted = (await start.json()) as StartRunResult;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        readFileSync(evidence, "utf8");
        break;
      } catch {
        await Bun.sleep(20);
      }
    }
    const processEvidence = JSON.parse(readFileSync(evidence, "utf8")) as {
      readonly runnerPid: number;
      readonly childPid: number;
    };
    expect(alive(processEvidence.runnerPid)).toBe(true);
    expect(alive(processEvidence.childPid)).toBe(true);

    const cancelled = await call(daemon, `/api/v1/runs/${admitted.runId}/actions/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "cancel-blocked",
        dataIdentity: daemon.endpoint.dataIdentity,
      }),
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(202);
    expect((await cancelled.json()) as CancelRunResult).toMatchObject({
      runId: admitted.runId,
      cancellation: "confirmed",
      executionStopped: true,
      state: "cancelled",
    });
    expect(alive(processEvidence.runnerPid)).toBe(false);
    expect(alive(processEvidence.childPid)).toBe(false);
    const run = (await (
      await call(daemon, `/api/v1/runs/${admitted.runId}`)
    ).json()) as RunDocument;
    expect(run).toMatchObject({
      state: "cancelled",
      revisionId: admitted.revisionId,
      cancellation: { state: "confirmed", source: "run" },
      cleanup: { state: "confirmed" },
    });
    expect(readFileSync(evidence, "utf8")).toContain(String(processEvidence.runnerPid));
  });
});
