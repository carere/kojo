import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { startDaemon } from "../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { AtomicArtifactRepository } from "../../../src/contexts/trace/adapters/AtomicArtifactRepository.ts";
import { captureWorkflowRevision } from "../../../src/contexts/workflow/services/captureRevision.ts";
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
  const workflowProject = join(root, "project-missing");
  mkdirSync(join(workflowProject, ".kojo", "workflows"), { recursive: true });
  writeFileSync(
    join(workflowProject, "package.json"),
    JSON.stringify({ name: "console-workflow-fixture", private: true, type: "module" }),
  );
  symlinkSync(
    resolve(import.meta.dirname, "../../../../../node_modules"),
    join(workflowProject, "node_modules"),
  );
  writeFileSync(
    join(workflowProject, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: [] }),
  );
  writeFileSync(
    join(workflowProject, ".kojo", "workflows", "available.ts"),
    `import { Effect, Layer, Schema, Stream } from "effect";
import { Trigger } from "@carere/kojo-runtime/contexts/trigger/ports/Trigger";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

const trigger = Layer.succeed(Trigger)({
  stream: Stream.never,
  ack: () => Effect.void,
});

export const available = workflow(
  {
    name: "available",
    payload: Schema.Null,
    success: Schema.Null,
    error: Schema.Never,
    idempotencyKey: () => "fixture",
    trigger,
  },
  () => Effect.succeed(null),
);
`,
  );
  execFileSync("git", ["-C", workflowProject, "add", ".kojo", "package.json"]);
  execFileSync("git", ["-C", workflowProject, "commit", "-m", "test: add Workflow fixture"]);
  const captured = captureWorkflowRevision({
    project: workflowProject,
    dataRoot: paths.dataRoot,
    workflowName: "available",
  });
  const database = new Database(join(paths.dataRoot, "kojo.db"));
  const project = database
    .query<{ readonly project_id: string }, []>(
      "SELECT project_id FROM projects ORDER BY registered_at LIMIT 1",
    )
    .get();
  if (project === null) throw new Error("the Workflow fixture has no Project");
  const now = "2026-09-01T00:00:00.000Z";
  const available = captured.revisionId;
  const removed = "b".repeat(64);
  database.run(
    `INSERT INTO workflow_revisions (
       revision_id, package_graph_id, manifest_json, published_path, published_at
     ) VALUES (?, ?, ?, ?, ?)`,
    [
      captured.revisionId,
      captured.packageGraphId,
      JSON.stringify(captured.manifest),
      captured.publishedPath,
      now,
    ],
  );
  database.run(
    `INSERT INTO workflow_revisions (
       revision_id, package_graph_id, manifest_json, published_path, published_at
     ) VALUES (?, ?, '{}', ?, ?)`,
    [removed, removed, join(paths.dataRoot, "revisions", removed), now],
  );
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
      name: "faulted",
      availability: "available",
      activity: "active",
      revision: available,
      fault: null,
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
        workflow.name === "available"
          ? "polling"
          : workflow.name === "faulted"
            ? "failed"
            : "not-declared",
        workflow.name === "available"
          ? "Trigger position 42"
          : workflow.name === "faulted"
            ? "five transient acknowledgement retries were exhausted"
            : null,
        now,
      ],
    );
  }
  database.run(
    `INSERT INTO workflow_runs (
       run_id, project_id, workflow_name, idempotency_key, payload_json, revision_id,
       package_graph_id, state, admission_sequence, admitted_at
     ) VALUES ('run-queued', ?, 'available', 'fixture', 'null', ?, ?, 'queued', 1, ?)`,
    [project.project_id, available, captured.packageGraphId, now],
  );
  database.run(
    `INSERT INTO workflow_queue (
       run_id, project_id, admission_sequence, queued_at, queue_kind, queue_reason
     ) VALUES ('run-queued', ?, 1, ?, 'new', 'runner-starting')`,
    [project.project_id, now],
  );
  database.close(false);
}

if (fixture === "gates") {
  const database = new Database(join(paths.dataRoot, "kojo.db"));
  database.run("PRAGMA foreign_keys = OFF");
  const revision = "c".repeat(64);
  const graph = "d".repeat(64);
  const fixtureNow = Date.now();
  const createdAt = new Date(fixtureNow - 60 * 60 * 1_000).toISOString();
  const openDeadline = new Date(fixtureNow + 60 * 60 * 1_000).toISOString();
  const expiredDeadline = new Date(fixtureNow - 1_000).toISOString();
  const recordedAt = new Date(fixtureNow - 30 * 60 * 1_000).toISOString();
  const appliedAt = new Date(fixtureNow - 29 * 60 * 1_000).toISOString();
  const fixtures = [
    { name: "unanswered", state: "unanswered", runState: "suspended" },
    { name: "answerable", state: "unanswered", runState: "suspended" },
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
    const deadline = gate.state === "expired" ? expiredDeadline : openDeadline;
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
        hasVerdict ? recordedAt : null,
        gate.state === "applied" ? appliedAt : null,
        gate.state === "expired" ? deadline : null,
        gate.state === "expired" ? new Date(fixtureNow).toISOString() : null,
        "terminalInability" in gate ? gate.terminalInability : null,
      ],
    );
  }
  const content = new TextEncoder().encode("<script>window.__artifactExecuted = true</script>\n");
  const artifactRepository = new AtomicArtifactRepository(database, paths.dataRoot);
  artifactRepository.begin({
    transferId: "browser-artifact-transfer",
    runId: "run-applied",
    name: "agent <output>.txt",
    mediaType: "text/plain; charset=utf-8",
    totalSize: content.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
  });
  artifactRepository.write("browser-artifact-transfer", 0, content);
  const artifact = artifactRepository.finish("browser-artifact-transfer", createdAt);
  writeFileSync(join(root, "artifact-id"), artifact.artifactId);
  database.close(false);
}

const stop = (): void => {
  void Effect.runPromise(daemon.stop).finally(() => rmSync(root, { recursive: true, force: true }));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Effect.runPromise(daemon.stopped);
