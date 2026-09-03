import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type {
  RunDocument,
  RunSnapshot,
  StartRunResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import { afterEach, describe, it as effectIt, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";
import type { RevisionDetails } from "../../../../src/contexts/workflow/models/RevisionMaintenance.ts";
import { captureWorkflowRevision } from "../../../../src/contexts/workflow/services/captureRevision.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";
import { linkEngine } from "../../../support/linkEngine.ts";

const roots: string[] = [];
const daemons: RunningDaemon[] = [];
const packageRoot = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");

class RunApiTestFault extends Data.TaggedError("RunApiTestFault")<{
  readonly cause: unknown;
}> {}

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

const project = (root: string, runnerPid: string, holdExecution = false): string => {
  const location = join(root, "project");
  mkdirSync(join(location, ".kojo", "workflows"), { recursive: true });
  const execution = holdExecution
    ? `Effect.sync(() => writeFileSync(${JSON.stringify(runnerPid)}, String(process.pid))).pipe(Effect.andThen(Effect.never))`
    : `Effect.sync(() => {
      writeFileSync(${JSON.stringify(runnerPid)}, String(process.pid));
      return null;
    })`;
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
    ${execution},
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

const offlineProject = (
  root: string,
  effectJournal: string,
  installMarker: string,
): { readonly location: string; readonly localPackage: string } => {
  const location = join(root, "offline-project");
  const localPackage = join(root, "offline-package");
  mkdirSync(join(location, ".kojo", "workflows"), { recursive: true });
  mkdirSync(localPackage, { recursive: true });
  linkEngine({ root: location, packageRoot });
  symlinkSync(localPackage, join(location, "node_modules", "fixture-offline"));
  writeFileSync(
    join(localPackage, "package.json"),
    JSON.stringify({
      name: "fixture-offline",
      version: "1.0.0",
      exports: "./index.ts",
      scripts: {
        postinstall: `bun -e ${JSON.stringify(`await Bun.write(${JSON.stringify(installMarker)}, "installed")`)}`,
      },
    }),
  );
  writeFileSync(join(localPackage, "index.ts"), 'export const retainedPackage = "package-a";\n');
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ name: "offline-run-api-fixture", private: true, type: "module" }),
  );
  writeFileSync(join(location, ".env"), "KOJO_OFFLINE_POISON=loaded-live-env\n");
  writeFileSync(
    join(location, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: ["prompt.md"] }),
  );
  writeFileSync(join(location, ".kojo", "prompt.md"), "retained prompt a\n");
  writeFileSync(
    join(location, ".kojo", "workflows", "version.ts"),
    'export const retainedSource = "source-a";\n',
  );
  writeFileSync(
    join(location, ".kojo", "workflows", "offline.ts"),
    `import { appendFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { retainedPackage } from "fixture-offline";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";
import { retainedSource } from "./version.ts";

export const offline = workflow(
  {
    name: "offline",
    payload: Schema.Null,
    success: Schema.Null,
    error: Schema.Never,
    idempotencyKey: () => "offline-retained-run",
  },
  () => code(
    {
      name: "count-effect",
      description: "Count the exact retained effect",
      success: Schema.Null,
      error: Schema.Never,
    },
    Effect.sync(() => {
      if (process.env.KOJO_OFFLINE_POISON !== undefined) {
        throw new Error("the current Project environment file was loaded");
      }
      appendFileSync(${JSON.stringify(effectJournal)}, retainedSource + ":" + retainedPackage + "\\n");
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
  execFileSync("git", ["-C", location, "commit", "-m", "test: offline fixture"]);
  return { location: realpathSync(location), localPackage };
};

const triggerSwitchProject = (root: string): string => {
  const location = join(root, "trigger-switch-project");
  mkdirSync(join(location, ".kojo", "workflows"), { recursive: true });
  linkEngine({ root: location, packageRoot });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({ name: "trigger-switch-fixture", private: true, type: "module" }),
  );
  writeFileSync(
    join(location, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: [] }),
  );
  execFileSync("git", ["init", "--initial-branch=main", location]);
  execFileSync("git", ["-C", location, "config", "user.email", "test@kojo.local"]);
  execFileSync("git", ["-C", location, "config", "user.name", "Kojo Test"]);
  return realpathSync(location);
};

const historicalTriggerSource = (
  journal: string,
): string => `import { appendFileSync, readFileSync } from "node:fs";
import { Effect, Layer, Schema, Stream } from "effect";
import { TriggerEvent } from "@carere/kojo-runtime/contexts/trigger/models/TriggerEvent";
import { Trigger } from "@carere/kojo-runtime/contexts/trigger/ports/Trigger";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

const priorEvents = readFileSync(${JSON.stringify(journal)}, "utf8");
const priorPids = [...new Set([...priorEvents.matchAll(/current-pid:[^:]+:(\\d+)/g)].map((match) => Number(match[1])))];
for (const priorPid of priorPids) {
  let priorPollerAlive = priorPid > 0;
  try { process.kill(priorPid, 0); } catch { priorPollerAlive = false; }
  if (priorPollerAlive) throw new Error("historical source imported before all current polling stopped");
}
appendFileSync(${JSON.stringify(journal)}, "current-pollers-confirmed-stopped\\n");
appendFileSync(${JSON.stringify(journal)}, "historical-imported\\n");
const trigger = Layer.succeed(Trigger)({
  stream: Stream.fromEffect(Effect.sync(() => {
    appendFileSync(${JSON.stringify(journal)}, "historical-trigger-started\\n");
    return new TriggerEvent({ source: "historical", key: "forbidden", payload: { ticket: "forbidden" }, receivedAt: Date.now() });
  })).pipe(Stream.concat(Stream.never)),
  ack: () => Effect.void,
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
    { name: "historical-effect", description: "Run historical effect", success: Schema.String, error: Schema.Never },
    Effect.sync(() => {
      appendFileSync(${JSON.stringify(journal)}, "historical-executed\\n");
      return payload.ticket;
    }),
  ),
);
`;

const currentTriggerSource = (
  journal: string,
  checkpoint: string,
  workflowName = "tickets",
): string => `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Effect, Layer, Schema, Stream } from "effect";
import { TriggerEvent } from "@carere/kojo-runtime/contexts/trigger/models/TriggerEvent";
import { Trigger } from "@carere/kojo-runtime/contexts/trigger/ports/Trigger";
import { code } from "@carere/kojo-runtime/contexts/workflow/services/phase/code";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

appendFileSync(${JSON.stringify(journal)}, "current-pid:${workflowName}:" + process.pid + "\\n");
appendFileSync(${JSON.stringify(journal)}, "current-imported:${workflowName}\\n");
const checkpoint = () => readFileSync(${JSON.stringify(checkpoint)}, "utf8").trim();
const allCurrentPollingRestored: Effect.Effect<void> = Effect.suspend(() => {
  const observations = readFileSync(${JSON.stringify(journal)}, "utf8")
    .trim()
    .split(String.fromCharCode(10));
  const executedAt = observations.lastIndexOf("historical-executed");
  const restored = executedAt >= 0 && ["tickets", "alerts"].every(
    (name) => observations.indexOf("polling-started:" + name + ":1", executedAt + 1) >= 0,
  );
  return restored
    ? Effect.void
    : Effect.sleep(20).pipe(Effect.andThen(allCurrentPollingRestored));
});
const event = Effect.sync(() => {
  const at = checkpoint();
  appendFileSync(${JSON.stringify(journal)}, "polling-started:${workflowName}:" + at + "\\n");
  return at;
}).pipe(
  Effect.flatMap((at) => allCurrentPollingRestored.pipe(
    Effect.flatMap(() => at === "1"
      ? Effect.succeed(new TriggerEvent({ source: "checkpoint", key: "${workflowName}-1", payload: { ticket: "${workflowName}-1" }, receivedAt: Date.now() }))
      : Effect.never),
  )),
);
const trigger = Layer.succeed(Trigger)({
  stream: Stream.fromEffect(event).pipe(
    Stream.concat(Stream.never),
    Stream.ensuring(Effect.sync(() => appendFileSync(${JSON.stringify(journal)}, "polling-stopped:${workflowName}:" + checkpoint() + "\\n"))),
  ),
  ack: (event) => Effect.sync(() => {
    appendFileSync(${JSON.stringify(journal)}, "acknowledged:${workflowName}:" + event.key + "\\n");
    writeFileSync(${JSON.stringify(checkpoint)}, "2\\n");
  }),
});

export const selected = workflow(
  {
    name: "${workflowName}",
    payload: { ticket: Schema.String },
    success: Schema.String,
    error: Schema.Never,
    idempotencyKey: (payload) => payload.ticket,
    trigger,
  },
  (payload) => code(
    { name: "current-effect", description: "Run current effect", success: Schema.String, error: Schema.Never },
    Effect.succeed(payload.ticket),
  ),
);
`;

const call = (daemon: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://localhost${path}`, {
    unix: daemon.endpoint.socketPath,
    ...init,
  } as RequestInit & { readonly unix: string });

const mutate = async (
  daemon: RunningDaemon,
  path: string,
  mutation: MutationEnvelope,
): Promise<Response> => {
  const prepared = await call(daemon, `/api/v1/client-requests/${mutation.requestId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  expect(prepared.status, await prepared.clone().text()).toBe(201);
  return call(daemon, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
};

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

const symbolicLinksUnder = (root: string): ReadonlyArray<string> => {
  const links: string[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      links.push(path);
      return;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) visit(join(path, child));
    }
  };
  visit(root);
  return links;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Daemon no-Trigger Run API", () => {
  it("stops all current Trigger polling before historical import and restores all checkpoints in one Runner", async () => {
    const hostPaths = paths();
    const root = roots[0] ?? "";
    const journal = join(root, "switch-events.txt");
    const checkpoint = join(root, "tickets-checkpoint.txt");
    const alertCheckpoint = join(root, "alerts-checkpoint.txt");
    writeFileSync(journal, "");
    writeFileSync(checkpoint, "1\n");
    writeFileSync(alertCheckpoint, "1\n");
    const location = triggerSwitchProject(root);
    const workflowSource = join(location, ".kojo", "workflows", "tickets.ts");
    const alertSource = join(location, ".kojo", "workflows", "alerts.ts");
    writeFileSync(workflowSource, historicalTriggerSource(journal));
    mkdirSync(hostPaths.dataRoot, { recursive: true, mode: 0o700 });
    const historical = captureWorkflowRevision({
      project: location,
      dataRoot: hostPaths.dataRoot,
      workflowName: "tickets",
    });
    writeFileSync(workflowSource, currentTriggerSource(journal, checkpoint, "tickets"));
    writeFileSync(alertSource, currentTriggerSource(journal, alertCheckpoint, "alerts"));
    const current = captureWorkflowRevision({
      project: location,
      dataRoot: hostPaths.dataRoot,
      workflowName: "tickets",
    });
    const alerts = captureWorkflowRevision({
      project: location,
      dataRoot: hostPaths.dataRoot,
      workflowName: "alerts",
    });
    execFileSync("git", ["-C", location, "add", "."]);
    execFileSync("git", ["-C", location, "commit", "-m", "test: trigger switch fixture"]);

    const databasePath = join(hostPaths.dataRoot, "kojo.db");
    const database = new Database(databasePath, { create: true, strict: true });
    database.run(
      "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
    );
    const projects = new SqliteProjectRepository(database);
    const registered = await Effect.runPromise(
      projects.register({
        requestId: "seed-historical-trigger",
        requestBody: "seed-historical-trigger",
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
              source: workflowSource,
              triggerDeclared: true,
              revision: historical,
            },
            {
              workflowName: "alerts",
              availability: "available",
              source: alertSource,
              triggerDeclared: true,
              revision: alerts,
            },
          ],
        },
      }),
    );
    await Effect.runPromise(
      projects.refresh(
        registered.project.projectId,
        {
          factoryState: "available",
          workflows: [
            {
              workflowName: "tickets",
              availability: "available",
              source: workflowSource,
              triggerDeclared: true,
              revision: current,
            },
            {
              workflowName: "alerts",
              availability: "available",
              source: alertSource,
              triggerDeclared: true,
              revision: alerts,
            },
          ],
        },
        "current",
        "2026-09-01T00:00:01.000Z",
      ),
    );
    await Effect.runPromise(
      projects.startActivity({
        dataIdentity: "seed-data",
        requestId: "start-current-trigger",
        projectId: registered.project.projectId,
        workflowName: "tickets",
        changedAt: "2026-09-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      projects.startActivity({
        dataIdentity: "seed-data",
        requestId: "start-current-alert-trigger",
        projectId: registered.project.projectId,
        workflowName: "alerts",
        changedAt: "2026-09-01T00:00:02.000Z",
      }),
    );
    const runs = new SqliteRunRepository(database);
    const admission = await Effect.runPromise(
      runs.admit({
        dataIdentity: "seed-data",
        requestId: "admit-historical-trigger-run",
        canonicalRequest: "admit-historical-trigger-run",
        projectId: registered.project.projectId,
        workflowName: "tickets",
        idempotencyKey: "historical-run",
        payload: { ticket: "historical-run" },
        revisionId: historical.revisionId,
        packageGraphId: historical.packageGraphId,
        admittedAt: "2026-09-01T00:00:03.000Z",
      }),
    );
    database.close(false);
    chmodSync(databasePath, 0o600);

    const daemon = startDaemon(hostPaths, { automaticRefresh: false, runnerIdleMillis: 50 });
    daemons.push(daemon);
    expect((await waitForRun(daemon, admission.run.runId)).state).toBe("succeeded");
    const deadline = Date.now() + 10_000;
    while (
      (readFileSync(checkpoint, "utf8").trim() !== "2" ||
        readFileSync(alertCheckpoint, "utf8").trim() !== "2") &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
    }
    const events = readFileSync(journal, "utf8").trim().split("\n");
    expect(readFileSync(checkpoint, "utf8").trim(), events.join("\n")).toBe("2");
    expect(readFileSync(alertCheckpoint, "utf8").trim(), events.join("\n")).toBe("2");
    expect(events).not.toContain("historical-trigger-started");
    const stopped = events.indexOf("current-pollers-confirmed-stopped");
    const imported = events.indexOf("historical-imported");
    const executed = events.indexOf("historical-executed");
    const resumedTickets = events.indexOf("polling-started:tickets:1", stopped + 1);
    const resumedAlerts = events.indexOf("polling-started:alerts:1", stopped + 1);
    const acknowledgedTickets = events.indexOf("acknowledged:tickets:tickets-1");
    const acknowledgedAlerts = events.indexOf("acknowledged:alerts:alerts-1");
    const firstAcknowledged = Math.min(acknowledgedTickets, acknowledgedAlerts);
    const runnerPids = (
      selected: ReadonlyArray<string>,
    ): ReadonlyArray<{ readonly workflowName: string; readonly pid: string }> =>
      selected.flatMap((event) => {
        const match = /^current-pid:([^:]+):(\d+)$/.exec(event);
        return match === null
          ? []
          : [{ workflowName: match[1] as string, pid: match[2] as string }];
      });
    const initialPids = runnerPids(events.slice(0, stopped));
    const resumedPids = runnerPids(events.slice(executed + 1, firstAcknowledged));
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(imported).toBeGreaterThan(stopped);
    expect(executed).toBeGreaterThan(imported);
    expect(resumedTickets, events.join("\n")).toBeGreaterThan(executed);
    expect(resumedAlerts, events.join("\n")).toBeGreaterThan(executed);
    expect(resumedTickets, events.join("\n")).toBeLessThan(firstAcknowledged);
    expect(resumedAlerts, events.join("\n")).toBeLessThan(firstAcknowledged);
    expect(acknowledgedTickets, events.join("\n")).toBeGreaterThan(resumedTickets);
    expect(acknowledgedAlerts, events.join("\n")).toBeGreaterThan(resumedAlerts);
    expect([...new Set(initialPids.map(({ workflowName }) => workflowName))].sort()).toEqual([
      "alerts",
      "tickets",
    ]);
    expect(new Set(initialPids.map(({ pid }) => pid)).size).toBe(1);
    expect([...new Set(resumedPids.map(({ workflowName }) => workflowName))].sort()).toEqual([
      "alerts",
      "tickets",
    ]);
    expect(new Set(resumedPids.map(({ pid }) => pid)).size).toBe(1);
  });

  it("executes one retained effect with the current Factory and packages removed and the registry unavailable", async () => {
    const hostPaths = paths();
    const root = roots[0] ?? "";
    const effectJournal = join(root, "effects.txt");
    const installMarker = join(root, "installed.txt");
    const subject = offlineProject(root, effectJournal, installMarker);
    mkdirSync(hostPaths.dataRoot, { recursive: true, mode: 0o700 });
    const captured = captureWorkflowRevision({
      project: subject.location,
      dataRoot: hostPaths.dataRoot,
      workflowName: "offline",
    });
    const databasePath = join(hostPaths.dataRoot, "kojo.db");
    const database = new Database(databasePath, { create: true, strict: true });
    database.run(
      "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
    );
    const projects = new SqliteProjectRepository(database);
    const registered = await Effect.runPromise(
      projects.register({
        requestId: "seed-offline-project",
        requestBody: "seed-offline-project",
        dataIdentity: "seed-data",
        location: subject.location,
        observedAt: "2026-09-01T00:00:00.000Z",
        factory: {
          state: "available",
          refreshState: "current",
          workflows: [
            {
              workflowName: "offline",
              availability: "available",
              source: join(subject.location, ".kojo", "workflows", "offline.ts"),
              revision: captured,
            },
          ],
        },
      }),
    );
    const runs = new SqliteRunRepository(database);
    const admission = await Effect.runPromise(
      runs.admit({
        dataIdentity: "seed-data",
        requestId: "admit-offline-run",
        canonicalRequest: "admit-offline-run",
        projectId: registered.project.projectId,
        workflowName: "offline",
        idempotencyKey: "offline-retained-run",
        payload: null,
        revisionId: captured.revisionId,
        packageGraphId: captured.packageGraphId,
        admittedAt: "2026-09-01T00:00:01.000Z",
      }),
    );
    database.close(false);
    chmodSync(databasePath, 0o600);

    rmSync(join(subject.location, ".kojo"), { recursive: true, force: true });
    rmSync(join(subject.location, "node_modules"), { recursive: true, force: true });
    rmSync(subject.localPackage, { recursive: true, force: true });

    const priorRegistry = process.env.BUN_CONFIG_REGISTRY;
    process.env.BUN_CONFIG_REGISTRY = "http://127.0.0.1:1/registry-is-unavailable";
    try {
      const daemon = startDaemon(hostPaths, { automaticRefresh: false, runnerIdleMillis: 50 });
      daemons.push(daemon);
      const run = await waitForRun(daemon, admission.run.runId);
      expect(run.state).toBe("succeeded");
      expect(readFileSync(effectJournal, "utf8")).toBe("source-a:package-a\n");
      expect(existsSync(installMarker)).toBe(false);
      expect(existsSync(join(subject.location, ".kojo"))).toBe(false);
      expect(existsSync(join(subject.location, "node_modules"))).toBe(false);

      await Effect.runPromise(daemon.stop);
      daemons.splice(daemons.indexOf(daemon), 1);
      const restarted = startDaemon(hostPaths, { automaticRefresh: false, runnerIdleMillis: 50 });
      daemons.push(restarted);
      await Bun.sleep(250);
      expect(readFileSync(effectJournal, "utf8")).toBe("source-a:package-a\n");
      const restored = await waitForRun(restarted, admission.run.runId);
      expect(restored.state).toBe("succeeded");
    } finally {
      if (priorRegistry === undefined) delete process.env.BUN_CONFIG_REGISTRY;
      else process.env.BUN_CONFIG_REGISTRY = priorRegistry;
    }
  });

  it("admits an exact retained revision and seals its stopped Runner cache for removal", async () => {
    const hostPaths = paths();
    const release = join(hostPaths.installationRoot, "releases", "kojo-test");
    mkdirSync(join(release, "runtime"), { recursive: true, mode: 0o700 });
    writeFileSync(join(release, "runtime", "bun"), "test managed Bun\n", { mode: 0o700 });
    writeFileSync(join(release, "launcher.js"), "test managed launcher\n", { mode: 0o600 });
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
    const startBody: MutationEnvelope = {
      mutationVersion: 1,
      requestId: "start-exact-null",
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "startWorkflow",
      target: {
        identityVersion: 1,
        kind: "workflow",
        parts: [registered.project.projectId, "example"],
      },
      arguments: { payload: null },
      preconditions: { mode: "no-trigger", revisionId: captured.revisionId },
    };
    const staleRevision = await mutate(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/workflows/example/actions/start`,
      {
        ...startBody,
        requestId: "start-stale-revision",
        preconditions: { mode: "no-trigger", revisionId: "f".repeat(64) },
      },
    );
    expect(staleRevision.status).toBe(409);
    expect(await staleRevision.text()).toContain("changed after Start was reviewed");
    const staleMode = await mutate(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/workflows/example/actions/start`,
      {
        ...startBody,
        requestId: "start-stale-mode",
        preconditions: { mode: "trigger", revisionId: captured.revisionId },
      },
    );
    expect(staleMode.status).toBe(409);
    expect(await staleMode.text()).toContain("changed after Start was reviewed");
    const beforeValid = (await (await call(daemon, "/api/v1/runs")).json()) as {
      readonly runs: ReadonlyArray<unknown>;
    };
    expect(beforeValid.runs).toEqual([]);
    const response = await mutate(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/workflows/example/actions/start`,
      startBody,
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
    const loadedRevision = (await (
      await call(
        daemon,
        `/api/v1/projects/${registered.project.projectId}/revisions/${captured.revisionId}`,
      )
    ).json()) as RevisionDetails;
    expect(loadedRevision.activeReaders).toEqual([
      expect.objectContaining({ kind: "loaded", runnerInstanceId: expect.any(String) }),
    ]);
    expect(loadedRevision.protections).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "loaded-registration" })]),
    );
    await Bun.sleep(700);
    expect(() => process.kill(pid, 0)).toThrow();

    const revisionResponse = await call(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/revisions/${captured.revisionId}`,
    );
    expect(revisionResponse.status, await revisionResponse.clone().text()).toBe(200);
    const revision = (await revisionResponse.json()) as RevisionDetails;
    expect(revision).toMatchObject({
      revisionId: captured.revisionId,
      packageGraphId: captured.packageGraphId,
      manifest: captured.manifest,
      dependentRuns: [{ runId: admitted.runId, state: "succeeded" }],
      activeReaders: [],
      collection: { state: "protected" },
    });
    expect(revision.protections.map((entry) => entry.reason).sort()).toEqual([
      "current-workflow",
      "retained-run",
    ]);
    const repairMutation: MutationEnvelope = {
      mutationVersion: 1,
      requestId: "repair-exact-revision",
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "repairRevision",
      target: {
        identityVersion: 1,
        kind: "workflowRevision",
        parts: [registered.project.projectId, captured.revisionId],
      },
      arguments: { from: captured.publishedPath },
      preconditions: {},
    };
    const repairResponse = await mutate(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/revisions/${captured.revisionId}/actions/repair`,
      repairMutation,
    );
    expect(repairResponse.status, await repairResponse.clone().text()).toBe(200);
    const repairBody = (await repairResponse.json()) as RevisionDetails;
    expect(repairBody).toMatchObject({ faults: [] });
    const repairReplay = (await (
      await call(daemon, "/api/v1/client-requests/repair-exact-revision/retry", {
        method: "POST",
      })
    ).json()) as { readonly result: unknown };
    expect(repairReplay).toMatchObject({ result: repairBody });
    const repairConflict = await call(daemon, "/api/v1/client-requests/repair-exact-revision", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...repairMutation,
        arguments: { from: join(hostPaths.dataRoot, "replacement") },
      }),
    });
    expect(repairConflict.status).toBe(409);

    const snapshot = (await (await call(daemon, "/api/v1/runs")).json()) as RunSnapshot;
    expect(snapshot.runs).toEqual([run]);
    const scoped = (await (
      await call(daemon, `/api/v1/projects/${registered.project.projectId}/runs`)
    ).json()) as RunSnapshot;
    expect(scoped.runs).toEqual([run]);

    const duplicate = await mutate(
      daemon,
      `/api/v1/projects/${registered.project.projectId}/workflows/example/actions/start`,
      { ...startBody, requestId: "start-same-key" },
    );
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ runId: run.runId, duplicate: true });

    const executionRoot = join(hostPaths.dataRoot, "runner-materialized");
    const retainedLinks = symbolicLinksUnder(executionRoot);
    expect(retainedLinks.some((path) => path.includes("node_modules"))).toBe(true);
    const operationId = "remove-after-retained-run";
    const requestHash = "a".repeat(64);
    await Effect.runPromise(
      daemon.lifecycleControl.inspectPreflight(
        operationId,
        daemon.endpoint.dataIdentity,
        requestHash,
      ),
    );
    await Effect.runPromise(
      daemon.lifecycleControl.beginDrain(operationId, daemon.endpoint.dataIdentity, requestHash),
    );
    const handoff = await Effect.runPromise(daemon.lifecycleControl.prepareHandoff(operationId));
    await Effect.runPromise(
      daemon.lifecycleControl.confirmControllerReady(operationId, handoff.digest),
    );
    const owner = await Effect.runPromise(
      daemon.lifecycleControl.stopOwnedProcesses(operationId, 30_000, false),
    );
    expect(owner.runnerInstanceIds).toEqual([]);
    const evidence = await Effect.runPromise(
      daemon.lifecycleControl.sealPurgeSafety?.(operationId) ??
        Effect.die("the production lifecycle has no purge safety owner"),
    );
    expect(existsSync(executionRoot)).toBe(false);
    expect(
      evidence.ownedScope.some(({ relativePath }) =>
        relativePath.startsWith("runner-materialized"),
      ),
    ).toBe(false);
  });

  effectIt.live("settles an active dispatch before Daemon storage closes", () =>
    Effect.tryPromise({
      try: async () => {
        const hostPaths = paths();
        const runnerPid = join(roots[0] ?? "", "shutdown-runner.pid");
        const location = project(roots[0] ?? "", runnerPid, true);
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
            requestId: "seed-shutdown-project",
            requestBody: "seed-shutdown-project",
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
        const response = await mutate(
          daemon,
          `/api/v1/projects/${registered.project.projectId}/workflows/example/actions/start`,
          {
            mutationVersion: 1,
            requestId: "start-shutdown-run",
            dataIdentity: daemon.endpoint.dataIdentity,
            operation: "startWorkflow",
            target: {
              identityVersion: 1,
              kind: "workflow",
              parts: [registered.project.projectId, "example"],
            },
            arguments: { payload: null },
            preconditions: { mode: "no-trigger", revisionId: captured.revisionId },
          },
        );
        expect(response.status, await response.clone().text()).toBe(202);
        const startedDeadline = Date.now() + 10_000;
        while (!existsSync(runnerPid) && Date.now() < startedDeadline) await Bun.sleep(10);
        expect(existsSync(runnerPid)).toBe(true);

        const unhandled: unknown[] = [];
        const captureUnhandled = (cause: unknown): void => {
          unhandled.push(cause);
        };
        process.on("unhandledRejection", captureUnhandled);
        try {
          await Effect.runPromise(daemon.stop);
          daemons.splice(daemons.indexOf(daemon), 1);
          await Bun.sleep(100);
        } finally {
          process.off("unhandledRejection", captureUnhandled);
        }
        expect(unhandled).toEqual([]);
      },
      catch: (cause) => new RunApiTestFault({ cause }),
    }),
  );

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
    const start = await mutate(daemon, startPath, {
      mutationVersion: 1,
      requestId: "start-trigger",
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "startWorkflow",
      target: {
        identityVersion: 1,
        kind: "workflow",
        parts: [registered.project.projectId, "tickets"],
      },
      arguments: {},
      preconditions: { mode: "trigger", revisionId: captured.revisionId },
    });
    expect(start.status, await start.clone().text()).toBe(202);
    expect(await start.json()).toMatchObject({
      kind: "trigger",
      activity: "active",
      pollerStarted: true,
    });
    const repeated = await mutate(daemon, startPath, {
      mutationVersion: 1,
      requestId: "repeat-trigger",
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "startWorkflow",
      target: {
        identityVersion: 1,
        kind: "workflow",
        parts: [registered.project.projectId, "tickets"],
      },
      arguments: {},
      preconditions: { mode: "trigger", revisionId: captured.revisionId },
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
    await Bun.sleep(250);

    const stop = await mutate(daemon, `${startPath.replace("/start", "/stop")}`, {
      mutationVersion: 1,
      requestId: "stop-trigger",
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "stopWorkflow",
      target: {
        identityVersion: 1,
        kind: "workflow",
        parts: [registered.project.projectId, "tickets"],
      },
      arguments: {},
      preconditions: {},
    });
    expect(stop.status, await stop.clone().text()).toBe(202);
    const stopBody = await stop.json();
    const stopReplay = (await (
      await call(daemon, "/api/v1/client-requests/stop-trigger/retry", { method: "POST" })
    ).json()) as { readonly result: unknown };
    expect(stopReplay).toMatchObject({ result: stopBody });
    const stopConflict = await call(daemon, "/api/v1/client-requests/stop-trigger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutationVersion: 1,
        requestId: "stop-trigger",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "stopWorkflow",
        target: {
          identityVersion: 1,
          kind: "workflow",
          parts: [registered.project.projectId, "tickets"],
        },
        arguments: { force: true },
        preconditions: {},
      }),
    });
    expect(stopConflict.status).toBe(409);
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
  });
});
