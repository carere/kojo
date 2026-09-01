import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { startDaemon } from "../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { publishConsoleRelease } from "./consoleRelease.ts";

const root = resolve(process.argv[2] ?? "");
const port = Number(process.argv[3]);
const assets = resolve(process.argv[4] ?? "");
const fixture = process.argv[5];
if (!root.startsWith("/tmp/") || !Number.isInteger(port) || port < 1) {
  throw new Error("usage: authenticatedConsoleServer.ts /tmp/ROOT PORT ASSETS");
}
rmSync(root, { recursive: true, force: true });
const installationRoot = join(root, "installation");
const paths: DaemonPaths = {
  installationRoot,
  dataRoot: join(root, "data"),
  configurationRoot: join(root, "config"),
  cacheRoot: join(root, "cache"),
  runtimeRoot: join(root, "runtime"),
  serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
  managedCli: join(installationRoot, "bin", "kojo"),
  managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
};
publishConsoleRelease(paths, { assets, releaseId: "kojo-browser-test" });
const daemon = startDaemon(paths, {
  consolePort: port,
  automaticRefresh: fixture !== "workflows",
});

if (fixture === "projects" || fixture === "workflows") {
  for (const [index, state] of ["missing", "invalid"].entries()) {
    const projectPath = join(root, `project-${state}`);
    mkdirSync(projectPath);
    const project = realpathSync(projectPath);
    execFileSync("git", ["init", "--initial-branch=main", project]);
    execFileSync("git", ["-C", project, "config", "user.email", "test@kojo.local"]);
    execFileSync("git", ["-C", project, "config", "user.name", "Kojo Test"]);
    writeFileSync(join(project, "README.md"), `${state}\n`);
    execFileSync("git", ["-C", project, "add", "README.md"]);
    execFileSync("git", ["-C", project, "commit", "-m", "test: initial"]);
    if (state === "invalid") mkdirSync(join(project, ".kojo"));
    const requestId = `browser-project-${index}`;
    const mutation = {
      mutationVersion: 1,
      requestId,
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "registerProject",
      target: {
        identityVersion: 1,
        kind: "daemonData",
        parts: [daemon.endpoint.dataIdentity],
      },
      arguments: { location: project },
      preconditions: {},
    };
    const prepared = await fetch(`http://localhost/api/v1/client-requests/${requestId}`, {
      unix: daemon.endpoint.socketPath,
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mutation),
    });
    if (!prepared.ok) throw new Error(`fixture preparation failed: ${await prepared.text()}`);
    const committed = await fetch(`http://localhost/api/v1/client-requests/${requestId}/retry`, {
      unix: daemon.endpoint.socketPath,
      method: "POST",
    });
    if (!committed.ok) throw new Error(`fixture registration failed: ${await committed.text()}`);
  }
}

if (fixture === "workflows") {
  const database = new Database(join(paths.dataRoot, "kojo.db"));
  const project = database
    .query<{ readonly project_id: string }, []>(
      "SELECT project_id FROM projects ORDER BY registered_at LIMIT 1",
    )
    .get();
  if (project === null) throw new Error("the Workflow fixture has no Project");
  const now = "2026-09-01T00:00:00.000Z";
  const available = "a".repeat(64);
  const removed = "b".repeat(64);
  for (const revision of [available, removed]) {
    database.run(
      `INSERT INTO workflow_revisions (
         revision_id, package_graph_id, manifest_json, published_path, published_at
       ) VALUES (?, ?, '{}', ?, ?)`,
      [revision, revision, join(paths.dataRoot, "revisions", revision), now],
    );
  }
  database.run(
    `UPDATE projects
        SET factory_state = 'available', refresh_state = 'current', refreshed_at = ?,
            fault = NULL, remedy = NULL
      WHERE project_id = ?`,
    [now, project.project_id],
  );
  for (const workflow of [
    {
      name: "available",
      availability: "available",
      activity: "active",
      revision: available,
      fault: null,
    },
    {
      name: "invalid",
      availability: "invalid",
      activity: "inactive",
      revision: available,
      fault: "declares another name",
    },
    {
      name: "removed",
      availability: "removed",
      activity: "inactive",
      revision: removed,
      fault: null,
    },
  ]) {
    database.run(
      `INSERT INTO project_workflows (
         project_id, workflow_name, activity, availability, source, source_fault, remedy,
         current_revision_id, candidate_revision_id, trigger_state, trigger_detail, refreshed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        project.project_id,
        workflow.name,
        workflow.activity,
        workflow.availability,
        join(root, "project-missing", ".kojo", "workflows", `${workflow.name}.ts`),
        workflow.fault,
        workflow.fault === null ? null : "Make the declared name match the file name.",
        workflow.revision,
        workflow.name === "available" ? "polling" : "not-declared",
        workflow.name === "available" ? "Trigger position 42" : null,
        now,
      ],
    );
  }
  database.close(false);
}

if (fixture === "gates") {
  const database = new Database(join(paths.dataRoot, "kojo.db"));
  database.run("PRAGMA foreign_keys = OFF");
  const revision = "c".repeat(64);
  const graph = "d".repeat(64);
  const createdAt = "2026-09-01T10:00:00.000Z";
  const deadline = "2026-09-02T10:00:00.000Z";
  const fixtures = [
    { name: "unanswered", state: "unanswered", runState: "suspended" },
    { name: "recorded", state: "recorded", runState: "suspended" },
    { name: "applied", state: "applied", runState: "succeeded" },
    { name: "expired", state: "expired", runState: "succeeded" },
    {
      name: "unable",
      state: "recorded",
      runState: "failed",
      terminalInability: "run-failed",
    },
  ] as const;
  for (const [index, gate] of fixtures.entries()) {
    const runId = `run-${gate.name}`;
    database.run(
      `INSERT INTO workflow_runs (
         run_id, project_id, workflow_name, idempotency_key, payload_json,
         revision_id, package_graph_id, state, admission_sequence, admitted_at, started_at, finished_at
       ) VALUES (?, 'project-gates', 'release', ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        gate.name,
        revision,
        graph,
        gate.runState,
        index + 1,
        createdAt,
        createdAt,
        gate.runState === "succeeded" || gate.runState === "failed" ? createdAt : null,
      ],
    );
    const hasVerdict = gate.state === "recorded" || gate.state === "applied";
    database.run(
      `INSERT INTO gate_askings (
         identity_key, token, run_id, project_id, workflow_name, gate_path,
         asking_number, escalation_stage, description, actor, choices_json,
         deadline, expiry_branch, internal_deferred_name, created_at, state,
         verdict_choice, verdict_reason, answerer, recorded_at, applied_at,
         expired_at, expiry_applied_at, terminal_inability
       ) VALUES (?, ?, ?, 'project-gates', 'release', ?, 1, 0, ?, 'release-manager',
                 '["approve","reject"]', ?, 'fail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        JSON.stringify([1, runId, `release/${gate.name}`, 1, 0]),
        `browser-token-${gate.name}`,
        runId,
        `release/${gate.name}`,
        `Decide the ${gate.name} release`,
        deadline,
        `gate/release/${gate.name}/1`,
        createdAt,
        gate.state,
        hasVerdict ? "approve" : null,
        hasVerdict ? "verified" : null,
        hasVerdict ? "fixture-operator" : null,
        hasVerdict ? "2026-09-01T10:05:00.000Z" : null,
        gate.state === "applied" ? "2026-09-01T10:06:00.000Z" : null,
        gate.state === "expired" ? deadline : null,
        gate.state === "expired" ? "2026-09-02T10:00:01.000Z" : null,
        "terminalInability" in gate ? gate.terminalInability : null,
      ],
    );
  }
  database.close(false);
}

const stop = (): void => {
  void Effect.runPromise(daemon.stop).finally(() => rmSync(root, { recursive: true, force: true }));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Effect.runPromise(daemon.stopped);
