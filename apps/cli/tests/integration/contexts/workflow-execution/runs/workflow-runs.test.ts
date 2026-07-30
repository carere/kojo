import { Database } from "bun:sqlite";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeTemporaryDirectory, runKojoCli } from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);
const effectPackagePath = fileURLToPath(
  new URL("../../../../../../../apps/host/node_modules/effect", import.meta.url),
);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const initializeGit = async (path: string) => {
  const child = Bun.spawn(["git", "init", path], { stdout: "ignore", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};

const installWorkflowDependencies = async (path: string) => {
  await mkdir(join(path, "node_modules", "@kojo"), { recursive: true });
  await symlink(workflowPackagePath, join(path, "node_modules", "@kojo", "workflow"), "dir");
  await symlink(await realpath(effectPackagePath), join(path, "node_modules", "effect"), "dir");
};

const configuration = `
import { Effect, Schema } from "effect";
import { defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "echo",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.succeed("echo:" + message)
    }),
    defineWorkflow({
      workflowKey: "declared-failure",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.fail("declared")
    }),
    defineWorkflow({
      workflowKey: "defect",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.die("defect")
    }),
    defineWorkflow({
      workflowKey: "invalid-result",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.succeed(42)
    }),
    defineWorkflow({
      workflowKey: "retry-exhausted",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: () => Effect.fail("retry").pipe(Effect.retry({ times: 1 }))
    }),
    defineWorkflow({
      workflowKey: "slow",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.sleep("3 seconds").pipe(Effect.as("echo:" + message))
    })
  ]
});
`;

it("starts, redelivers, lists, and shows one durable Workflow Run", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-runs-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  const initialized = await runKojoCli(["init", project], host.socketPath);
  expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
  const invalidInput = await runKojoCli(
    ["run", "start", "echo", "--input", '{"message":42}', "--json"],
    host.socketPath,
    project,
  );
  expect(invalidInput.exitCode).toBe(4);
  expect(JSON.parse(invalidInput.stdout).error.code).toBe("workflow-input-invalid");
  const beforeFirstStart = await runKojoCli(["run", "list", "--json"], host.socketPath, project);
  expect(beforeFirstStart.exitCode).toBe(0);
  expect(JSON.parse(beforeFirstStart.stdout).result).toEqual([]);
  const first = await runKojoCli(
    [
      "run",
      "start",
      "echo",
      "--input",
      '{"message":"hello"}',
      "--request-key",
      "run-request-one",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(first.exitCode, `${first.stdout}${first.stderr}`).toBe(0);
  const firstResult = JSON.parse(first.stdout).result;
  expect(firstResult).toMatchObject({
    alreadyApplied: false,
    run: {
      workflowKey: "echo",
      workflowRevision: "1",
      state: "completed",
      startSnapshot: {
        environment: {
          definitionSnapshotId: expect.any(String),
          runtimeKind: "local-effect-workflow",
        },
        input: { message: "hello" },
        trigger: { kind: "manual", requestKey: "run-request-one" },
      },
      outcome: { kind: "completed", value: "echo:hello" },
    },
  });
  const database = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    const events = database
      .query(
        "SELECT sequence, kind, payload_json FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence",
      )
      .all(firstResult.run.runId) as ReadonlyArray<{
      readonly sequence: number;
      readonly kind: string;
      readonly payload_json: string;
    }>;
    const accepted = events[0];
    expect(accepted).toMatchObject({ sequence: 1, kind: "run.accepted" });
    if (accepted === undefined) throw new Error("Workflow Run has no accepted event");
    expect(JSON.parse(accepted.payload_json)).toEqual(firstResult.run.startSnapshot);
    const terminal = database
      .query(
        "SELECT state, outcome_summary_json, finalized_at_ms FROM kojo_workflow_runs WHERE run_id = ?",
      )
      .get(firstResult.run.runId) as {
      readonly state: string;
      readonly outcome_summary_json: string;
      readonly finalized_at_ms: number;
    };
    expect(terminal).toMatchObject({ state: "completed", finalized_at_ms: expect.any(Number) });
    expect(JSON.parse(terminal.outcome_summary_json)).toEqual({
      kind: "completed",
      value: "echo:hello",
    });
    expect(events.at(-1)).toMatchObject({ kind: "run.completed" });
  } finally {
    database.close();
  }

  const redelivery = await runKojoCli(
    [
      "run",
      "start",
      "echo",
      "--input",
      '{"message":"hello"}',
      "--request-key",
      "run-request-one",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(redelivery.exitCode).toBe(0);
  expect(JSON.parse(redelivery.stdout).result).toMatchObject({
    alreadyApplied: true,
    run: { runId: firstResult.run.runId },
  });

  const conflict = await runKojoCli(
    [
      "run",
      "start",
      "echo",
      "--input",
      '{"message":"different"}',
      "--request-key",
      "run-request-one",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(conflict.exitCode).toBe(4);
  expect(JSON.parse(conflict.stdout).error.code).toBe("request-key-conflict");

  const second = await runKojoCli(
    ["run", "start", "echo", "--input", '{"message":"hello"}', "--json"],
    host.socketPath,
    project,
  );
  expect(second.exitCode).toBe(0);
  expect(JSON.parse(second.stdout).result.run.runId).not.toBe(firstResult.run.runId);

  for (const workflowKey of ["declared-failure", "defect", "invalid-result", "retry-exhausted"]) {
    const failed = await runKojoCli(
      ["run", "start", workflowKey, "--input", '{"message":"hello"}', "--json"],
      host.socketPath,
      project,
    );
    expect(failed.exitCode, `${workflowKey}: ${failed.stdout}${failed.stderr}`).toBe(0);
    expect(JSON.parse(failed.stdout).result.run.state, workflowKey).toBe("failed");
  }

  const listed = await runKojoCli(
    ["run", "list", "--workflow", "echo", "--state", "completed", "--json"],
    host.socketPath,
    project,
  );
  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout).result).toHaveLength(2);

  const shown = await runKojoCli(
    ["run", "show", firstResult.run.runId, "--json"],
    host.socketPath,
    project,
  );
  expect(shown.exitCode).toBe(0);
  expect(JSON.parse(shown.stdout).result).toMatchObject({ run: { runId: firstResult.run.runId } });
});

it("reconciles a non-final Workflow Run after the Host restarts", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-runs-restart-");
  cleanups.push(directory.cleanup);
  const hostStore = await makeTemporaryDirectory("kojo-workflow-runs-host-");
  cleanups.push(hostStore.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const firstHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(firstHost.stop);
  const initialized = await runKojoCli(["init", project], firstHost.socketPath);
  expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
  const started = await runKojoCli(
    ["run", "start", "slow", "--input", '{"message":"after-restart"}', "--json"],
    firstHost.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  expect(JSON.parse(started.stdout).result.run.state).toBe("running");
  await firstHost.stop();

  const secondHost = await startKojoHostProcess({ storePath: hostStore.path });
  cleanups.push(secondHost.stop);
  const listed = await runKojoCli(["run", "list", "--json"], secondHost.socketPath, project);
  expect(listed.exitCode, `${listed.stdout}${listed.stderr}`).toBe(0);
  const recovered = JSON.parse(listed.stdout).result.find(
    (run: { readonly workflowKey: string }) => run.workflowKey === "slow",
  );
  expect(recovered?.state).toMatch(/^(running|completed)$/);
  const shown = await runKojoCli(
    ["run", "show", JSON.parse(started.stdout).result.run.runId, "--json"],
    secondHost.socketPath,
    project,
  );
  expect(shown.exitCode, `${shown.stdout}${shown.stderr}`).toBe(0);
  expect(JSON.parse(shown.stdout).result.run).toMatchObject({
    state: "completed",
    outcome: { kind: "completed", value: "echo:after-restart" },
  });
});
