import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteExternalActionRepository } from "../../../../src/contexts/workflow/adapters/SqliteExternalActionRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";
import { captureWorkflowRevision } from "../../../../src/contexts/workflow/services/captureRevision.ts";
import {
  externalActionId,
  externalActionInputHash,
} from "../../../../src/contexts/workflow/services/externalActionIdentity.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";
import { linkEngine } from "../../../support/linkEngine.ts";

const clientCli = new URL("../../../support/daemon/clientCli.ts", import.meta.url).pathname;
const packageRoot = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const roots: string[] = [];
const daemons: RunningDaemon[] = [];
const faultServers: Bun.Server<unknown>[] = [];

interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const paths = (): DaemonPaths => {
  const root = mkdtempSync(join(process.cwd(), ".kojo-cli-contract-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  const result = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(result);
  return result;
};

const admit = async (
  runs: SqliteRunRepository,
  projectId: string,
  key: string,
  payload: JsonValue,
  revisionId: string,
  packageGraphId: string,
) =>
  Effect.runPromise(
    runs.admit({
      dataIdentity: "data-cli",
      requestId: `admit-${key}`,
      canonicalRequest: JSON.stringify([projectId, key, payload]),
      projectId,
      workflowName: "compile",
      idempotencyKey: key,
      payload,
      revisionId,
      packageGraphId,
      admittedAt: "2026-09-01T00:00:00.000Z",
    }),
  );

const fixture = async () => {
  const hostPaths = paths();
  mkdirSync(hostPaths.dataRoot, { recursive: true, mode: 0o700 });
  const workflowProject = join(roots.at(-1) ?? "", "project-a");
  mkdirSync(join(workflowProject, ".kojo", "workflows"), { recursive: true });
  writeFileSync(
    join(workflowProject, "package.json"),
    JSON.stringify({ name: "cli-contract-project", private: true, type: "module" }),
  );
  writeFileSync(
    join(workflowProject, ".kojo", "factory.json"),
    JSON.stringify({ formatVersion: 1, assets: [] }),
  );
  writeFileSync(
    join(workflowProject, ".kojo", "workflows", "compile.ts"),
    `import { Effect, Schema } from "effect";
import { workflow } from "@carere/kojo-runtime/contexts/workflow/services/workflow";

export const compile = workflow(
  {
    name: "compile",
    payload: Schema.Struct({ message: Schema.String }),
    success: Schema.Null,
    error: Schema.Never,
    idempotencyKey: (payload) => payload.message,
  },
  () => Effect.succeed(null),
);
`,
  );
  linkEngine({ root: workflowProject, packageRoot });
  execFileSync("git", ["init", "--initial-branch=main", workflowProject]);
  execFileSync("git", ["-C", workflowProject, "config", "user.email", "test@kojo.local"]);
  execFileSync("git", ["-C", workflowProject, "config", "user.name", "Kojo Test"]);
  execFileSync("git", ["-C", workflowProject, "add", "."]);
  execFileSync("git", ["-C", workflowProject, "commit", "-m", "test: CLI fixture"]);
  const captured = captureWorkflowRevision({
    project: workflowProject,
    dataRoot: hostPaths.dataRoot,
    workflowName: "compile",
  });
  const databasePath = join(hostPaths.dataRoot, "kojo.db");
  const database = new Database(databasePath, { create: true, strict: true });
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  new SqliteProjectRepository(database);
  for (const projectId of ["project-a", "project-b"]) {
    database.run(
      `INSERT INTO projects (
         project_id, location, project_state, factory_state, refresh_state,
         registered_at, refreshed_at, fault, remedy
       ) VALUES (?, ?, 'available', 'available', 'current', ?, ?, NULL, NULL)`,
      [
        projectId,
        projectId === "project-a" ? workflowProject : join(roots.at(-1) ?? "", projectId),
        "2026-09-01",
        "2026-09-01",
      ],
    );
    database.run(
      "INSERT INTO project_workflows VALUES (?, 'compile', 'inactive', 'available', 'workflows/compile.ts', NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, '2026-09-01')",
      [projectId, captured.revisionId],
    );
  }
  database.run("INSERT INTO workflow_revisions VALUES (?, ?, ?, ?, '2026-09-01')", [
    captured.revisionId,
    captured.packageGraphId,
    JSON.stringify(captured.manifest),
    captured.publishedPath,
  ]);
  const runs = new SqliteRunRepository(database);
  const succeeded = await admit(
    runs,
    "project-a",
    "succeeded",
    { password: "secret-must-not-leave-storage" },
    captured.revisionId,
    captured.packageGraphId,
  );
  const failed = await admit(
    runs,
    "project-b",
    "failed",
    { private: "other-project" },
    captured.revisionId,
    captured.packageGraphId,
  );
  const following = await admit(
    runs,
    "project-a",
    "following",
    null,
    captured.revisionId,
    captured.packageGraphId,
  );
  database.run(
    "UPDATE workflow_runs SET state = 'succeeded', started_at = ?, finished_at = ? WHERE run_id = ?",
    ["2026-09-01T00:00:01.000Z", "2026-09-01T00:00:02.000Z", succeeded.run.runId],
  );
  database.run(
    "UPDATE workflow_runs SET state = 'failed', started_at = ?, finished_at = ? WHERE run_id = ?",
    ["2026-09-01T00:00:01.000Z", "2026-09-01T00:00:02.000Z", failed.run.runId],
  );
  database.run("UPDATE workflow_runs SET state = 'suspended' WHERE run_id = ?", [
    following.run.runId,
  ]);
  database.run("DELETE FROM workflow_queue");

  const uncertain = await admit(
    runs,
    "project-a",
    "uncertain",
    null,
    captured.revisionId,
    captured.packageGraphId,
  );
  const authority = await Effect.runPromise(
    runs.claim(uncertain.run.runId, "runner-cli", "2026-09-01T00:00:01.000Z"),
  );
  const actions = new SqliteExternalActionRepository(database);
  const inputHash = externalActionInputHash({ command: ["publish"] });
  const actionId = externalActionId({
    runId: uncertain.run.runId,
    revisionId: captured.revisionId,
    phasePath: "publish",
    attempt: 1,
    inputHash,
  });
  await Effect.runPromise(
    actions.begin({
      authority,
      actionId,
      phasePath: "publish",
      attempt: 1,
      inputHash,
      recoveryPolicy: "unresolved",
      intendedAt: "2026-09-01T00:00:01.000Z",
    }),
  );
  await Effect.runPromise(
    actions.holdOpen(
      uncertain.run.runId,
      "the provider result is not known",
      "2026-09-01T00:00:02.000Z",
    ),
  );
  await Effect.runPromise(
    actions.settleAfterRunnerTermination(authority, "2026-09-01T00:00:03.000Z"),
  );
  database.close(false);
  chmodSync(databasePath, 0o600);

  const daemon = startDaemon(hostPaths, { automaticRefresh: false });
  daemons.push(daemon);
  return {
    root: roots.at(-1) ?? "",
    workflowProject,
    hostPaths,
    daemon,
    databasePath,
    succeeded: succeeded.run.runId,
    failed: failed.run.runId,
    following: following.run.runId,
    uncertain: uncertain.run.runId,
    actionId,
  };
};

const runCli = async (root: string, args: ReadonlyArray<string>): Promise<Ran> => {
  const child = Bun.spawn([process.execPath, clientCli, root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
};

const runFollow = async (test: Awaited<ReturnType<typeof fixture>>): Promise<Ran> => {
  const child = Bun.spawn(
    [process.execPath, clientCli, test.root, "run", "status", test.following, "--follow", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let resolveFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const stdout = (async () => {
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes("\n")) resolveFirst?.();
    }
  })();
  await Promise.race([
    first,
    Bun.sleep(5_000).then(() => {
      throw new Error("the real follow command did not print its first JSON Line");
    }),
  ]);
  const database = new Database(test.databasePath, { strict: true });
  database.run("UPDATE workflow_runs SET state = 'succeeded', finished_at = ? WHERE run_id = ?", [
    "2026-09-01T00:00:04.000Z",
    test.following,
  ]);
  database.close(false);
  const [status, output, stderr] = await Promise.all([
    child.exited,
    stdout,
    new Response(child.stderr).text(),
  ]);
  return { status, stdout: output, stderr };
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const server of faultServers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real CLI process over the private Daemon transport", () => {
  it("uses positional Project registration and top-level request status and retry", async () => {
    const test = await fixture();
    const registered = await runCli(test.root, [
      "project",
      "register",
      test.workflowProject,
      "--request-id",
      "request-top-level-cli",
    ]);
    expect(registered.status, registered.stderr).toBe(0);
    expect(registered.stdout).toContain("request request-top-level-cli");

    const status = await runCli(test.root, [
      "status",
      "--request",
      "request-top-level-cli",
      "--json",
    ]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      formatVersion: 1,
      request: {
        request: { requestId: "request-top-level-cli" },
        receipt: { status: "committed" },
      },
    });

    const retried = await runCli(test.root, ["retry", "--request", "request-top-level-cli"]);
    expect(retried.status, retried.stderr).toBe(0);
    expect(JSON.parse(retried.stdout)).toMatchObject({
      requestId: "request-top-level-cli",
      status: "committed",
    });

    expect(
      (await runCli(test.root, ["project", "retry", "request-top-level-cli"])).status,
    ).not.toBe(0);
    expect(
      (await runCli(test.root, ["project", "register", "--path", test.workflowProject])).status,
    ).not.toBe(0);
  });

  it("applies full Project selectors and JSON input while keeping output free of private payloads", async () => {
    const test = await fixture();
    const workflows = await runCli(test.root, [
      "workflow",
      "list",
      "--project",
      "project-a",
      "--json",
    ]);
    expect(workflows.status, workflows.stderr).toBe(0);
    expect(JSON.parse(workflows.stdout).workflows).toMatchObject([
      { projectId: "project-a", workflowName: "compile" },
    ]);

    const runs = await runCli(test.root, ["run", "list", "--project", "project-a", "--json"]);
    expect(runs.status, runs.stderr).toBe(0);
    const selected = JSON.parse(runs.stdout) as { readonly runs: ReadonlyArray<RunDocument> };
    expect(selected.runs.every((run) => run.projectId === "project-a")).toBe(true);
    expect(runs.stdout).not.toContain("project-b");
    expect(runs.stdout).not.toContain("secret-must-not-leave-storage");
    expect(runs.stdout).not.toContain('"payload"');

    const started = await runCli(test.root, [
      "workflow",
      "start",
      "project-a",
      "compile",
      "--payload",
      '{"message":"private-start-input"}',
      "--json",
    ]);
    expect(started.status, started.stderr).toBe(0);
    const admission = JSON.parse(started.stdout) as { readonly runId: string };
    expect(admission.runId).toBeTruthy();
    expect(started.stdout).not.toContain("private-start-input");
    const database = new Database(test.databasePath, { strict: true });
    expect(
      database
        .query<{ readonly payload_json: string }, [string]>(
          "SELECT payload_json FROM workflow_runs WHERE run_id = ?",
        )
        .get(admission.runId)?.payload_json,
    ).toBe('{"message":"private-start-input"}');
    database.close(false);
  });

  it("streams one versioned JSON Line per changed state through a real follow command", async () => {
    const test = await fixture();
    const followed = await runFollow(test);
    expect(followed.status, followed.stderr).toBe(0);
    const lines = followed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.formatVersion)).toEqual([1, 1]);
    expect(lines.map((line) => line.run.state)).toEqual(["suspended", "succeeded"]);
  });

  it("returns exact usage, failure, wait-timeout, and success exits from real processes", async () => {
    const test = await fixture();
    const conflict = await runCli(test.root, [
      "run",
      "status",
      test.following,
      "--follow",
      "--wait",
    ]);
    expect(conflict.status).toBe(2);
    const failed = await runCli(test.root, ["run", "status", test.failed, "--wait"]);
    expect(failed.status).toBe(1);
    const timeout = await runCli(test.root, [
      "run",
      "status",
      test.following,
      "--wait",
      "--timeout",
      "100ms",
    ]);
    expect(timeout.status).toBe(3);
    const succeeded = await runCli(test.root, ["run", "status", test.succeeded, "--wait"]);
    expect(succeeded.status, succeeded.stderr).toBe(0);
  });

  it("authorizes only the exact uncertain Action through the real retry command", async () => {
    const test = await fixture();
    const wrong = await runCli(test.root, [
      "run",
      "resume",
      test.uncertain,
      "--retry-uncertain",
      "action_wrong",
      "--reason",
      "the provider has no result lookup",
      "--acknowledge-possible-duplication",
      "--json",
    ]);
    expect(wrong.status).toBe(1);

    const exact = await runCli(test.root, [
      "run",
      "resume",
      test.uncertain,
      "--retry-uncertain",
      test.actionId,
      "--reason",
      "the provider has no result lookup",
      "--acknowledge-possible-duplication",
      "--json",
    ]);
    expect(exact.status, exact.stderr).toBe(0);
    expect(JSON.parse(exact.stdout)).toMatchObject({
      formatVersion: 1,
      kind: "retry-uncertain",
      runId: test.uncertain,
      actionId: test.actionId,
    });
  });

  it("returns exit 4 when Gate mutation transport fails after endpoint discovery", async () => {
    const test = await fixture();
    const endpointPath = join(test.hostPaths.runtimeRoot, "endpoint.json");
    const endpoint = readFileSync(endpointPath, "utf8");
    await Effect.runPromise(test.daemon.stop);
    daemons.splice(daemons.indexOf(test.daemon), 1);
    mkdirSync(test.hostPaths.runtimeRoot, { recursive: true, mode: 0o700 });
    const faultServer = Bun.serve({
      unix: test.daemon.endpoint.socketPath,
      fetch: () =>
        new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    });
    faultServers.push(faultServer);
    chmodSync(test.daemon.endpoint.socketPath, 0o600);
    writeFileSync(endpointPath, endpoint, { mode: 0o600 });

    const unknown = await runCli(test.root, [
      "gate",
      "answer",
      "gate-token-after-owner-loss",
      "--choice",
      "approve",
    ]);
    expect(unknown.status, unknown.stderr).toBe(4);
    expect(unknown.stderr).toContain("kojo:");
  });
});
