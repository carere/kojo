import { Database } from "bun:sqlite";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
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

const sensitiveConfiguration = `
import { Effect, Schema } from "effect";
import { defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({
  credentials: Schema.Struct({ token: Schema.String }),
  message: Schema.String,
});
const success = Schema.Struct({ result: Schema.String, token: Schema.String });
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "sensitive-echo",
      revision: "1",
      inputSchema: input,
      successSchema: success,
      failureSchema: Schema.String,
      sensitivity: { input: ["credentials"], success: ["token"] },
      handler: ({ credentials, message }) => Effect.succeed({ result: "echo:" + message, token: credentials.token })
    })
  ]
});
`;

const durableWaitConfiguration = `
import { Effect, Schema } from "effect";
import { Workflow, defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "manual-wait",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Workflow.waitForResume({
        operationKey: "approval",
        valueSchema: Schema.String,
      }).pipe(Effect.map((approval) => message + ":" + approval)),
    }),
    defineWorkflow({
      workflowKey: "deferred-wait",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.gen(function* () {
        const deferred = yield* Workflow.deferred({
          operationKey: "approval",
          successSchema: Schema.String,
        });
        const approval = yield* Workflow.await(deferred);
        return message + ":" + approval;
      }),
    }),
  ],
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

it("masks marked payloads by default, fails closed for an invalid map, and reveals once with warnings", async () => {
  const directory = await makeTemporaryDirectory("kojo-sensitive-workflow-runs-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), sensitiveConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const started = await runKojoCli(
    [
      "run",
      "start",
      "sensitive-echo",
      "--input",
      '{"credentials":{"token":"top-secret-input"},"message":"hello"}',
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  expect(started.stdout).not.toContain("top-secret-input");
  const run = JSON.parse(started.stdout).result.run;
  expect(run.startSnapshot.input).toEqual({
    credentials: { _tag: "sensitive-value-masked" },
    message: "hello",
  });
  expect(run.outcome).toEqual({
    kind: "completed",
    value: { result: "echo:hello", token: { _tag: "sensitive-value-masked" } },
  });

  const database = new Database(join(project, ".kojo", "kojo.sqlite"));
  const maps = database
    .query(
      `SELECT payload_sensitivity_map_json
       FROM kojo_execution_events WHERE run_id = ? ORDER BY sequence`,
    )
    .all(run.runId) as ReadonlyArray<{ readonly payload_sensitivity_map_json: string }>;
  expect(JSON.parse(maps[0]?.payload_sensitivity_map_json ?? "null")).toEqual([
    "input.credentials",
  ]);
  database.exec("DROP TRIGGER kojo_execution_events_immutable");
  database
    .query(
      "UPDATE kojo_execution_events SET payload_sensitivity_map_version = 2 WHERE run_id = ? AND sequence = 1",
    )
    .run(run.runId);
  database.close();

  const failedClosed = await runKojoCli(
    ["run", "show", run.runId, "--json"],
    host.socketPath,
    project,
  );
  expect(failedClosed.exitCode, `${failedClosed.stdout}${failedClosed.stderr}`).toBe(0);
  expect(JSON.parse(failedClosed.stdout).result.run.startSnapshot).toEqual({
    _tag: "sensitive-value-masked",
  });

  const revealed = await runKojoCli(
    ["run", "show", run.runId, "--reveal", "--json"],
    host.socketPath,
    project,
  );
  expect(revealed.exitCode, `${revealed.stdout}${revealed.stderr}`).toBe(0);
  const revealedResult = JSON.parse(revealed.stdout);
  expect(revealedResult.result.run.startSnapshot.input.credentials.token).toBe("top-secret-input");
  expect(revealedResult.warnings).toEqual([
    expect.objectContaining({ code: "sensitive-content-not-scanned" }),
  ]);

  const humanReveal = await runKojoCli(
    ["run", "show", run.runId, "--reveal"],
    host.socketPath,
    project,
  );
  expect(humanReveal.exitCode, `${humanReveal.stdout}${humanReveal.stderr}`).toBe(0);
  expect(humanReveal.stderr).toContain("Revealed content may contain arbitrary secrets");

  const policyDatabase = new Database(join(project, ".kojo", "kojo.sqlite"), { readonly: true });
  try {
    expect(policyDatabase.query("SELECT * FROM kojo_retention_policy").all()).toEqual([]);
  } finally {
    policyDatabase.close();
  }

  const diagnostics = (await readFile(host.diagnosticPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        eventKind: "host-request.completed",
        operation: "RevealWorkflowRun",
        outcome: "success",
      }),
      expect.objectContaining({
        eventKind: "project-runtime.activation.completed",
        operation: "ProjectRuntimeActivate",
      }),
      expect.objectContaining({
        eventKind: "workflow-run.reconciliation.completed",
        operation: "ReconcileWorkflowRun",
      }),
    ]),
  );
  expect(JSON.stringify(diagnostics)).not.toContain("top-secret-input");
});

it("keeps manual resume and Workflow Deferred completion distinct and validates their values", async () => {
  const directory = await makeTemporaryDirectory("kojo-durable-waits-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), durableWaitConfiguration);
  const hostStore = join(directory.path, "host");
  const host = await startKojoHostProcess({ storePath: hostStore });

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const manualStart = await runKojoCli(
    ["run", "start", "manual-wait", "--input", '{"message":"manual"}', "--json"],
    host.socketPath,
    project,
  );
  expect(manualStart.exitCode, `${manualStart.stdout}${manualStart.stderr}`).toBe(0);
  const manual = JSON.parse(manualStart.stdout).result.run;
  expect(manual).toMatchObject({
    state: "suspended",
    suspension: { kind: "manual", operationKey: "approval" },
  });

  await host.stop();
  const restartedHost = await startKojoHostProcess({ storePath: hostStore });
  cleanups.push(restartedHost.stop);
  const afterRestart = await runKojoCli(
    ["run", "show", manual.runId, "--json"],
    restartedHost.socketPath,
    project,
  );
  expect(afterRestart.exitCode, `${afterRestart.stdout}${afterRestart.stderr}`).toBe(0);
  expect(JSON.parse(afterRestart.stdout).result.run).toMatchObject({
    state: "suspended",
    suspension: { kind: "manual", operationKey: "approval" },
  });

  const rejectedResume = await runKojoCli(
    ["run", "resume", manual.runId, "--value", "42", "--json"],
    restartedHost.socketPath,
    project,
  );
  expect(rejectedResume.exitCode, `${rejectedResume.stdout}${rejectedResume.stderr}`).toBe(4);
  expect(JSON.parse(rejectedResume.stdout).error.code).toBe("workflow-deferred-value-invalid");

  await writeFile(join(project, "approval.json"), '"approved"');

  const resumed = await runKojoCli(
    [
      "run",
      "resume",
      manual.runId,
      "--value-file",
      "approval.json",
      "--request-key",
      "resume-manual-wait",
      "--json",
    ],
    restartedHost.socketPath,
    project,
  );
  expect(resumed.exitCode, `${resumed.stdout}${resumed.stderr}`).toBe(0);
  expect(JSON.parse(resumed.stdout).result.run).toMatchObject({ state: "running" });
  const resumeRedelivery = await runKojoCli(
    [
      "run",
      "resume",
      manual.runId,
      "--value",
      '"approved"',
      "--request-key",
      "resume-manual-wait",
      "--json",
    ],
    restartedHost.socketPath,
    project,
  );
  expect(resumeRedelivery.exitCode, `${resumeRedelivery.stdout}${resumeRedelivery.stderr}`).toBe(0);
  expect(JSON.parse(resumeRedelivery.stdout).result.alreadyApplied).toBe(true);
  const finalResume = await runKojoCli(
    [
      "run",
      "resume",
      manual.runId,
      "--value",
      '"approved"',
      "--request-key",
      "resume-final-run",
      "--json",
    ],
    restartedHost.socketPath,
    project,
  );
  expect(finalResume.exitCode).toBe(4);
  expect(JSON.parse(finalResume.stdout).error.code).toBe("run-not-suspended");
});

it("completes a Workflow Deferred only with its token and a schema-valid value", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-deferred-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), durableWaitConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const deferredStart = await runKojoCli(
    ["run", "start", "deferred-wait", "--input", '{"message":"deferred"}', "--json"],
    host.socketPath,
    project,
  );
  expect(deferredStart.exitCode, `${deferredStart.stdout}${deferredStart.stderr}`).toBe(0);
  const deferred = JSON.parse(deferredStart.stdout).result.run;
  expect(deferred).toMatchObject({
    state: "suspended",
    suspension: {
      kind: "deferred",
      operationKey: "approval",
      completionToken: expect.any(String),
    },
  });

  const forbiddenResume = await runKojoCli(
    ["run", "resume", deferred.runId, "--value", '"approved"', "--json"],
    host.socketPath,
    project,
  );
  expect(forbiddenResume.exitCode).toBe(4);
  expect(JSON.parse(forbiddenResume.stdout).error.code).toBe("run-resume-not-allowed");

  const rejectedDeferred = await runKojoCli(
    [
      "run",
      "deferred",
      "complete",
      deferred.runId,
      deferred.suspension.completionToken,
      "--value",
      "42",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(rejectedDeferred.exitCode).toBe(4);
  expect(JSON.parse(rejectedDeferred.stdout).error.code).toBe("workflow-deferred-value-invalid");

  const completedDeferred = await runKojoCli(
    [
      "run",
      "deferred",
      "complete",
      deferred.runId,
      deferred.suspension.completionToken,
      "--value",
      '"approved"',
      "--request-key",
      "complete-deferred-wait",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(completedDeferred.exitCode, `${completedDeferred.stdout}${completedDeferred.stderr}`).toBe(
    0,
  );
  expect(JSON.parse(completedDeferred.stdout).result.run).toMatchObject({ state: "running" });
  const deferredRedelivery = await runKojoCli(
    [
      "run",
      "deferred",
      "complete",
      deferred.runId,
      deferred.suspension.completionToken,
      "--value",
      '"approved"',
      "--request-key",
      "complete-deferred-wait",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(
    deferredRedelivery.exitCode,
    `${deferredRedelivery.stdout}${deferredRedelivery.stderr}`,
  ).toBe(0);
  expect(JSON.parse(deferredRedelivery.stdout).result.alreadyApplied).toBe(true);
  let final = await runKojoCli(["run", "show", deferred.runId, "--json"], host.socketPath, project);
  for (
    let attempt = 0;
    attempt < 20 && JSON.parse(final.stdout).result.run.state !== "completed";
    attempt += 1
  ) {
    await Bun.sleep(50);
    final = await runKojoCli(["run", "show", deferred.runId, "--json"], host.socketPath, project);
  }
  expect(final.exitCode, `${final.stdout}${final.stderr}`).toBe(0);
  expect(JSON.parse(final.stdout).result.run, final.stdout).toMatchObject({
    state: "completed",
    outcome: { kind: "completed", value: "deferred:approved" },
  });
});
