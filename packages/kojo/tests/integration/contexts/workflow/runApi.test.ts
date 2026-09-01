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
  RunSnapshot,
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

const roots: string[] = [];
const daemons: RunningDaemon[] = [];

const paths = (): DaemonPaths => {
  const root = mkdtempSync(join(process.cwd(), ".kojo-run-api-"));
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

const project = (root: string, runnerPid: string): string => {
  const location = join(root, "project");
  mkdirSync(join(location, ".kojo", "workflows"), { recursive: true });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ name: "run-api-fixture", private: true, type: "module" }),
  );
  writeFileSync(
    join(location, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: [] }),
  );
  writeFileSync(
    join(location, ".kojo", "workflows", "example.ts"),
    `import { writeFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

export const example = workflow(
  {
    name: "example",
    payload: Schema.Null,
    success: Schema.Null,
    error: Schema.Never,
    idempotencyKey: () => "exact-null-run",
  },
  () => code(
    {
      name: "compile",
      description: "Compile the retained Project revision",
      success: Schema.Null,
      error: Schema.Never,
    },
    Effect.sync(() => {
      writeFileSync(${JSON.stringify(runnerPid)}, String(process.pid));
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
  execFileSync("git", ["-C", location, "commit", "-m", "test: fixture"]);
  return realpathSync(location);
};

const triggerProject = (root: string, acknowledgement: string): string => {
  const location = join(root, "trigger-project");
  mkdirSync(join(location, ".kojo", "workflows"), { recursive: true });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ name: "trigger-run-api-fixture", private: true, type: "module" }),
  );
  writeFileSync(
    join(location, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: [] }),
  );
  writeFileSync(
    join(location, ".kojo", "workflows", "tickets.ts"),
    `import { appendFileSync } from "node:fs";
import { Effect, Layer, Schema, Stream } from "effect";
import { TriggerEvent } from "@carere/kojo-runtime/contexts/trigger/models/TriggerEvent";
import { Trigger } from "@carere/kojo-runtime/contexts/trigger/ports/Trigger";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

const first = new TriggerEvent({
  source: "fixture",
  key: "ticket-one",
  payload: { ticket: "ticket-one" },
  receivedAt: Date.now(),
});
const second = new TriggerEvent({
  source: "fixture",
  key: "ticket-two",
  payload: { ticket: "ticket-two" },
  receivedAt: Date.now() + 500,
});
const trigger = Layer.succeed(Trigger)({
  stream: Stream.make(first).pipe(
    Stream.concat(Stream.fromEffect(Effect.sleep(500).pipe(Effect.as(second)))),
    Stream.concat(Stream.never),
  ),
  ack: (event, run) => Effect.sync(() =>
    appendFileSync(${JSON.stringify(acknowledgement)}, JSON.stringify({ key: event.key, run }) + "\\n"),
  ),
});

export const tickets = workflow(
  {
    name: "tickets",
    payload: { ticket: Schema.String },
    success: Schema.String,
    error: Schema.Never,
    idempotencyKey: (payload) => payload.ticket,
    trigger,
  },
  (payload) => code(
    {
      name: "handle-ticket",
      description: "Handle the admitted Trigger ticket",
      success: Schema.String,
      error: Schema.Never,
    },
    Effect.succeed(payload.ticket),
  ),
);
`,
  );
  execFileSync("git", ["init", "--initial-branch=main", location]);
  execFileSync("git", ["-C", location, "config", "user.email", "test@kojo.local"]);
  execFileSync("git", ["-C", location, "config", "user.name", "Kojo Test"]);
  execFileSync("git", ["-C", location, "add", "."]);
  execFileSync("git", ["-C", location, "commit", "-m", "test: trigger fixture"]);
  return realpathSync(location);
};

const call = (daemon: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost${path}`, {
    unix: daemon.endpoint.socketPath,
    ...init,
  } as RequestInit & { readonly unix: string });

const waitForRun = async (daemon: RunningDaemon, runId: string): Promise<RunDocument> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await call(daemon, `/api/v1/runs/${runId}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const run = (await response.json()) as RunDocument;
    if (run.state === "succeeded" || run.state === "failed") return run;
    await Bun.sleep(20);
  }
  throw new Error("the exact Run did not reach a terminal state");
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Daemon no-Trigger Run API", () => {
  it("admits an exact retained revision, reports status, and exposes a real code Phase", async () => {
    const hostPaths = paths();
    const runnerPid = join(roots[0] ?? "", "runner.pid");
    const location = project(roots[0] ?? "", runnerPid);
    mkdirSync(hostPaths.dataRoot, { recursive: true, mode: 0o700 });
    const captured = captureWorkflowRevision({
      project: location,
      dataRoot: hostPaths.dataRoot,
      workflowName: "example",
    });
    const databasePath = join(hostPaths.dataRoot, "kojo.db");
    const database = new Database(databasePath, { create: true, strict: true });
    database.run(
      "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
    );
    const projects = new SqliteProjectRepository(database);
    const registered = await Effect.runPromise(
      projects.register({
        requestId: "seed-project",
        requestBody: "seed-project",
        dataIdentity: "seed-data",
        location,
        observedAt: "2026-09-01T00:00:00.000Z",
        factory: {
          state: "available",
          refreshState: "current",
          workflows: [
            {
              workflowName: "example",
              availability: "available",
              source: join(location, ".kojo", "workflows", "example.ts"),
              revision: captured,
            },
          ],
        },
      }),
    );
    database.close(false);
    chmodSync(databasePath, 0o600);

    const daemon = startDaemon(hostPaths, { automaticRefresh: false, runnerIdleMillis: 500 });
    daemons.push(daemon);
    const startBody = {
      requestId: "start-exact-null",
      dataIdentity: daemon.endpoint.dataIdentity,
      payload: null,
    };
    const response = await call(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/workflows/example/actions/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(startBody),
      },
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const admitted = (await response.json()) as StartRunResult;
    expect(admitted).toMatchObject({ duplicate: false, revisionId: captured.revisionId });

    const run = await waitForRun(daemon, admitted.runId);
    expect(run).toMatchObject({
      runId: admitted.runId,
      projectId: registered.project.projectId,
      workflowName: "example",
      revisionId: captured.revisionId,
      packageGraphId: captured.packageGraphId,
      state: "succeeded",
    });
    expect(run.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phasePath: "compile",
          attempt: 1,
          kind: "code",
          outcome: "succeeded",
          description: "Compile the retained Project revision",
          result: expect.objectContaining({ _tag: "Complete" }),
        }),
      ]),
    );
    const compile = run.phases.find((phase) => phase.phasePath === "compile");
    expect(compile).toBeDefined();
    expect(Date.parse(compile?.startedAt ?? "")).toBeLessThanOrEqual(
      Date.parse(compile?.endedAt ?? ""),
    );
    expect(compile?.startedAt).not.toBe(run.finishedAt);
    const pid = Number(readFileSync(runnerPid, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await Bun.sleep(700);
    expect(() => process.kill(pid, 0)).toThrow();

    const snapshot = (await (await call(daemon, "/api/v1/runs")).json()) as RunSnapshot;
    expect(snapshot.runs).toEqual([run]);
    const scoped = (await (
      await call(daemon, `/api/v1/projects/${registered.project.projectId}/runs`)
    ).json()) as RunSnapshot;
    expect(scoped.runs).toEqual([run]);

    const duplicate = await call(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/workflows/example/actions/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...startBody, requestId: "start-same-key" }),
      },
    );
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ runId: run.runId, duplicate: true });
  }, 30_000);

  it("runs one authored Trigger poller, acknowledges after durable admission, and stops its boundary", async () => {
    const hostPaths = paths();
    const acknowledgement = join(roots[0] ?? "", "trigger-acknowledgements.jsonl");
    const location = triggerProject(roots[0] ?? "", acknowledgement);
    mkdirSync(hostPaths.dataRoot, { recursive: true, mode: 0o700 });
    const captured = captureWorkflowRevision({
      project: location,
      dataRoot: hostPaths.dataRoot,
      workflowName: "tickets",
    });
    const databasePath = join(hostPaths.dataRoot, "kojo.db");
    const database = new Database(databasePath, { create: true, strict: true });
    database.run(
      "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
    );
    const projects = new SqliteProjectRepository(database);
    const registered = await Effect.runPromise(
      projects.register({
        requestId: "seed-trigger-project",
        requestBody: "seed-trigger-project",
        dataIdentity: "seed-data",
        location,
        observedAt: "2026-09-01T00:00:00.000Z",
        factory: {
          state: "available",
          refreshState: "current",
          workflows: [
            {
              workflowName: "tickets",
              availability: "available",
              source: join(location, ".kojo", "workflows", "tickets.ts"),
              triggerDeclared: true,
              revision: captured,
            },
          ],
        },
      }),
    );
    database.close(false);
    chmodSync(databasePath, 0o600);

    const daemon = startDaemon(hostPaths, { automaticRefresh: false, runnerIdleMillis: 100 });
    daemons.push(daemon);
    const startPath = `/api/v1/projects/${registered.project.projectId}/workflows/tickets/actions/start`;
    const start = await call(daemon, startPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "start-trigger",
        dataIdentity: daemon.endpoint.dataIdentity,
      }),
    });
    expect(start.status, await start.clone().text()).toBe(202);
    expect(await start.json()).toMatchObject({
      kind: "trigger",
      activity: "active",
      pollerStarted: true,
    });
    const repeated = await call(daemon, startPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "repeat-trigger",
        dataIdentity: daemon.endpoint.dataIdentity,
      }),
    });
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toMatchObject({ pollerStarted: false });

    const deadline = Date.now() + 10_000;
    while (!existsSync(acknowledgement) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(acknowledgement)).toBe(true);
    const firstAcknowledgement = JSON.parse(
      readFileSync(acknowledgement, "utf8").trim().split("\n")[0] ?? "{}",
    ) as {
      readonly key?: string;
      readonly run?: { readonly runId?: string; readonly outcome?: string };
    };
    expect(firstAcknowledgement).toMatchObject({
      key: "ticket-one",
      run: { outcome: "admitted" },
    });
    const durableRun = await call(
      daemon,
      `/api/v1/runs/${firstAcknowledgement.run?.runId ?? "missing"}`,
    );
    expect(durableRun.status).toBe(200);

    const stop = await call(daemon, `${startPath.replace("/start", "/stop")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "stop-trigger",
        dataIdentity: daemon.endpoint.dataIdentity,
      }),
    });
    expect(stop.status, await stop.clone().text()).toBe(202);
    await Bun.sleep(700);
    const runs = (await (await call(daemon, "/api/v1/runs")).json()) as RunSnapshot;
    expect(runs.runs.map((run) => run.runId)).toEqual([firstAcknowledgement.run?.runId]);
    const workflows = await call(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/workflows`,
    );
    expect(await workflows.json()).toMatchObject({
      workflows: [
        expect.objectContaining({
          workflowName: "tickets",
          activity: "inactive",
          trigger: expect.objectContaining({ detail: "stopped" }),
        }),
      ],
    });
  }, 30_000);
});
