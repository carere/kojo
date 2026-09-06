import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { startDaemon } from "../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { AtomicArtifactRepository } from "../../../src/contexts/trace/adapters/AtomicArtifactRepository.ts";
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
const daemon = startDaemon(paths, { consolePort: port });

if (fixture === "projects") {
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
  const unableAt = new Date(fixtureNow - 28 * 60 * 1_000).toISOString();
  const expiryAppliedAt = new Date(fixtureNow).toISOString();
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
    const finishedAt =
      gate.state === "applied"
        ? appliedAt
        : gate.state === "expired"
          ? expiryAppliedAt
          : "terminalInability" in gate
            ? unableAt
            : null;
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
        finishedAt,
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
        gate.state === "expired" ? expiryAppliedAt : null,
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
console.log("Kojo browser fixture ready");
await Effect.runPromise(daemon.stopped);
