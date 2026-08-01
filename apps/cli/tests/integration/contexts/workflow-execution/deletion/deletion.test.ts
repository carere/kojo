import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeTemporaryDirectory, runKojoCli } from "../../../../../../../tests/support/cli-process";
import {
  type KojoHostProcessOptions,
  startKojoHostProcess,
} from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);
const effectPackagePath = fileURLToPath(
  new URL("../../../../../../../apps/host/node_modules/effect", import.meta.url),
);
const cliMainPath = fileURLToPath(
  new URL("../../../../../../../apps/cli/main.ts", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
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

const scheduledConfiguration = `
import { Effect, Schema } from "effect";
import { defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
export default defineConfig({
  workflows: [defineWorkflow({
    workflowKey: "echo",
    revision: "1",
    inputSchema: input,
    successSchema: Schema.String,
    failureSchema: Schema.String,
    schedules: [{
      scheduleKey: "morning-report",
      workflowKey: "echo",
      cron: "0 9 * * 1-5",
      timeZone: "Europe/Paris",
      overlap: "skip",
      input: {
        revision: "input-v1",
        resolve: ({ scheduleKey, scheduledAt }) => ({ message: scheduleKey + scheduledAt.toISOString() }),
      },
    }],
    handler: ({ message }) => Effect.succeed("echo:" + message),
  })],
});
`;

const unavailableScheduleConfiguration = `
import { Effect, Schema } from "effect";
import { defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
export default defineConfig({
  workflows: [defineWorkflow({
    workflowKey: "echo",
    revision: "1",
    inputSchema: input,
    successSchema: Schema.String,
    failureSchema: Schema.String,
    handler: ({ message }) => Effect.succeed("echo:" + message),
  })],
});
`;

const unscheduledConfiguration = `
import { Effect, Schema } from "effect";
import {
  Sandbox,
  defineConfig,
  defineCustomSandboxProvider,
  defineSandbox,
  defineWorkflow,
} from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
const provider = defineCustomSandboxProvider({
  kind: "custom",
  providerKey: "deletion-warning-provider",
  revision: "1",
  runCommand: () => Effect.succeed({ durationMs: 0, exitCode: 0, stderr: "", stdout: "" }),
});
const sandbox = defineSandbox({
  sandboxKey: "deletion-warning-sandbox",
  revision: "1",
  provider,
});
export default defineConfig({
  workflows: [defineWorkflow({
    workflowKey: "echo",
    revision: "1",
    inputSchema: input,
    successSchema: Schema.String,
    failureSchema: Schema.String,
    handler: ({ message }) => Effect.gen(function* () {
      yield* Sandbox.acquire({ operationKey: "deletion-warning", sandbox });
      return "echo:" + message;
    }),
  })],
});
`;

const childConfiguration = `
import { Effect, Schema } from "effect";
import { Workflow, defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
const invokeChild = (invocationKey, workflowKey, message) =>
  Workflow.invokeChild({ invocationKey, workflowKey, input: { message } }).pipe(Effect.map(String));

export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "child",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.succeed("child:" + message),
    }),
    defineWorkflow({
      workflowKey: "parent",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      childWorkflowKeys: ["child"],
      handler: ({ message }) => invokeChild("child", "child", message),
    }),
  ],
});
`;

const runningConfiguration = `
import { Effect, Schema } from "effect";
import { defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ message: Schema.String });
export default defineConfig({
  workflows: [defineWorkflow({
    workflowKey: "hold",
    revision: "1",
    inputSchema: input,
    successSchema: Schema.String,
    failureSchema: Schema.String,
    handler: () => Effect.never,
  })],
});
`;

const tolerateMissingCleanup = async (cleanup: () => Promise<void>) => {
  try {
    await cleanup();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const setupProject = async (configuration: string, hostOptions: KojoHostProcessOptions = {}) => {
  const directory = await makeTemporaryDirectory("kojo-deletion-project-");
  cleanups.push(() => tolerateMissingCleanup(directory.cleanup));
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration);
  const host = await startKojoHostProcess(hostOptions);
  cleanups.push(host.stop);
  const initialized = await runKojoCli(["init", project, "--json"], host.socketPath);
  expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
  const identity = JSON.parse(initialized.stdout).result.project.identity as string;
  return { host, identity, project };
};

// biome-ignore lint/suspicious/noExplicitAny: The process boundary is intentionally asserted through decoded JSON envelopes.
const readJson = (stdout: string) => JSON.parse(stdout) as Record<string, any>;

const fileExists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const waitForFinalRun = async (socketPath: string, project: string, runId: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const shown = await runKojoCli(["run", "show", runId, "--json"], socketPath, project);
    if (shown.exitCode === 0) {
      const run = readJson(shown.stdout).result.run as { state: string };
      if (["completed", "failed", "stopped"].includes(run.state)) return run;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Run ${runId} did not become final.`);
};

const confirmWithLostResponse = async (
  project: string,
  socketPath: string,
  identity: string,
  planKey: string,
) => {
  const child = Bun.spawn(
    [
      process.execPath,
      cliMainPath,
      "delete",
      "project",
      "--project-id",
      identity,
      "--plan-key",
      planKey,
      "--json",
    ],
    {
      cwd: project,
      env: { ...process.env, KOJO_HOST_SOCKET: socketPath },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const databasePath = join(project, ".kojo", "kojo.sqlite");
  let committed = false;
  for (let attempt = 0; attempt < 800; attempt += 1) {
    let database: Database | undefined;
    try {
      database = new Database(databasePath, { readonly: true, strict: true });
      const request = database
        .query("SELECT state FROM kojo_control_requests WHERE request_key = ?")
        .get(planKey) as { readonly state: string } | null;
      if (request?.state === "completed") {
        committed = true;
        if (child.exitCode === null) child.kill("SIGKILL");
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("database is locked")) throw error;
    } finally {
      database?.close();
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(10);
  }
  await child.exited;
  expect(committed).toBe(true);
};

it("enforces the exact two-step project protocol, drift protection, lost-response replay, and reset", async () => {
  const { host, identity, project } = await setupProject(scheduledConfiguration);
  const metadataPath = join(project, ".kojo", "project.json");
  const metadataBefore = await readFile(metadataPath, "utf8");
  const sourceBefore = await readFile(join(project, "kojo.config.ts"), "utf8");
  const orphanPath = join(project, ".kojo", "sandboxes", "orphaned-file.txt");
  const externalPath = join(project, "..", "outside-execution.txt");
  const symlinkPath = join(project, ".kojo", "sandboxes", "external-link");
  await mkdir(join(project, ".kojo", "sandboxes"), { recursive: true });
  await writeFile(orphanPath, "orphaned execution content");
  await writeFile(externalPath, "keep this external content");
  await symlink(externalPath, symlinkPath);
  const listed = await runKojoCli(
    ["schedule", "list", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(listed.exitCode, `${listed.stdout}${listed.stderr}`).toBe(0);
  const revision = readJson(listed.stdout).result[0].definition.revision as string;
  const started = await runKojoCli(
    [
      "run",
      "start",
      "echo",
      "--input",
      '{"message":"project-reset"}',
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = readJson(started.stdout).result.run.runId as string;
  await waitForFinalRun(host.socketPath, project, runId);

  const preview = await runKojoCli(
    ["delete", "project", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(preview.exitCode, `${preview.stdout}${preview.stderr}`).toBe(0);
  const plan = readJson(preview.stdout).result.preview;
  expect(plan.version).toBe(1);
  expect(plan.expiresAtMs - plan.observedAtMs).toBe(15 * 60 * 1_000);
  expect(plan.counts.runs).toBe(1);
  expect(plan.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "run", key: `run:${runId}` }),
      expect.objectContaining({
        kind: "owned-file",
        key: "file:.kojo/sandboxes/orphaned-file.txt",
      }),
      expect.objectContaining({ kind: "schedule", key: "schedule:morning-report" }),
    ]),
  );
  expect(plan.items).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "owned-file", key: "file:.kojo/sandboxes/external-link" }),
    ]),
  );

  for (const bypassFlag of ["--yes", "--force"]) {
    const bypass = await runKojoCli(
      ["delete", "project", "--project-id", identity, bypassFlag, "--json"],
      host.socketPath,
      project,
    );
    expect(bypass.exitCode).toBe(2);
  }
  const oneStep = await runKojoCli(
    ["delete", "project", "--project-id", identity, "--plan-key", "one-step-plan-key", "--json"],
    host.socketPath,
    project,
  );
  expect(oneStep.exitCode).toBe(4);
  expect(readJson(oneStep.stdout).error.code).toBe("plan-expired");

  const enabled = await runKojoCli(
    [
      "schedule",
      "enable",
      "morning-report",
      "--revision",
      revision,
      "--request-key",
      "enable-for-deletion-drift",
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(enabled.exitCode, `${enabled.stdout}${enabled.stderr}`).toBe(0);
  const drifted = await runKojoCli(
    ["delete", "project", "--project-id", identity, "--plan-key", plan.planKey, "--json"],
    host.socketPath,
    project,
  );
  expect(drifted.exitCode).toBe(4);
  expect(readJson(drifted.stdout).error.code).toBe("plan-drifted");

  const currentPreview = await runKojoCli(
    ["delete", "project", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  const currentPlan = readJson(currentPreview.stdout).result.preview;
  await confirmWithLostResponse(project, host.socketPath, identity, currentPlan.planKey);
  const replay = await runKojoCli(
    ["delete", "project", "--project-id", identity, "--plan-key", currentPlan.planKey, "--json"],
    host.socketPath,
    project,
  );
  expect(replay.exitCode, `${replay.stdout}${replay.stderr}`).toBe(0);
  expect(readJson(replay.stdout).result.receipt.requestKey).toBe(currentPlan.planKey);

  const database = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    expect(database.query("SELECT count(*) AS count FROM kojo_workflow_runs").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT count(*) AS count FROM kojo_execution_events").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT count(*) AS count FROM kojo_execution_artifacts").get()).toEqual({
      count: 0,
    });
    expect(
      database.query("SELECT count(*) AS count FROM kojo_execution_event_artifacts").get(),
    ).toEqual({ count: 0 });
    expect(
      database.query("SELECT count(*) AS count FROM kojo_workflow_activity_attempts").get(),
    ).toEqual({ count: 0 });
    expect(
      database.query("SELECT count(*) AS count FROM kojo_workflow_activity_operations").get(),
    ).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM kojo_engine_operations").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT count(*) AS count FROM cluster_messages").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT count(*) AS count FROM cluster_runners").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT count(*) AS count FROM cluster_locks").get()).toEqual({
      count: 0,
    });
    const receipt = database
      .query(
        "SELECT target_kind, target_run_id, target_schedule_key, result_json FROM kojo_control_requests WHERE request_key = ?",
      )
      .get(currentPlan.planKey) as Record<string, unknown>;
    expect(receipt.target_kind).toBe("none");
    expect(receipt.target_run_id).toBeNull();
    expect(receipt.target_schedule_key).toBeNull();
    expect(receipt.result_json).not.toContain(identity);
    expect(receipt.result_json).not.toContain(project);
  } finally {
    database.close();
  }

  expect(await fileExists(orphanPath)).toBe(false);
  expect(await fileExists(symlinkPath)).toBe(true);
  expect(await readFile(externalPath, "utf8")).toBe("keep this external content");
  expect(await readFile(metadataPath, "utf8")).toBe(metadataBefore);
  expect(await readFile(join(project, "kojo.config.ts"), "utf8")).toBe(sourceBefore);
  const diagnostics = await readFile(host.diagnosticPath, "utf8").catch(() => "");
  expect(diagnostics).not.toContain(identity);

  const rediscovered = await runKojoCli(
    ["schedule", "list", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(readJson(rediscovered.stdout).result[0]).toMatchObject({
    scheduleKey: "morning-report",
    enabledIntent: false,
    condition: "available",
  });
});

it("deletes a final Run and returns an honest unsupported-provider warning", async () => {
  const { host, identity, project } = await setupProject(unscheduledConfiguration);
  const started = await runKojoCli(
    ["run", "start", "echo", "--input", '{"message":"hello"}', "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = readJson(started.stdout).result.run.runId as string;
  await waitForFinalRun(host.socketPath, project, runId);

  const preview = await runKojoCli(
    ["delete", "run", runId, "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(preview.exitCode, `${preview.stdout}${preview.stderr}`).toBe(0);
  expect(readJson(preview.stdout).result.preview.counts.runs).toBe(1);
  const planKey = readJson(preview.stdout).result.preview.planKey as string;
  const confirmed = await runKojoCli(
    ["delete", "run", runId, "--project-id", identity, "--plan-key", planKey, "--json"],
    host.socketPath,
    project,
  );
  expect(confirmed.exitCode, `${confirmed.stdout}${confirmed.stderr}`).toBe(0);
  expect(readJson(confirmed.stdout).result.receipt.warnings).toEqual([
    expect.objectContaining({ code: "provider-unsupported" }),
  ]);
  const database = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    expect(
      database
        .query("SELECT count(*) AS count FROM kojo_workflow_runs WHERE run_id = ?")
        .get(runId),
    ).toEqual({ count: 0 });
  } finally {
    database.close();
  }
});

it("deletes a top-level Run together with its complete Child Run tree", async () => {
  const { host, identity, project } = await setupProject(childConfiguration);
  const started = await runKojoCli(
    ["run", "start", "parent", "--input", '{"message":"tree"}', "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const parentRunId = readJson(started.stdout).result.run.runId as string;
  await waitForFinalRun(host.socketPath, project, parentRunId);

  const preview = await runKojoCli(
    ["delete", "run", parentRunId, "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(preview.exitCode, `${preview.stdout}${preview.stderr}`).toBe(0);
  const previewResult = readJson(preview.stdout).result.preview;
  expect(previewResult.counts.runs).toBe(2);
  expect(previewResult.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "run", key: `run:${parentRunId}` })]),
  );

  const confirmed = await runKojoCli(
    [
      "delete",
      "run",
      parentRunId,
      "--project-id",
      identity,
      "--plan-key",
      previewResult.planKey,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(confirmed.exitCode, `${confirmed.stdout}${confirmed.stderr}`).toBe(0);
  const database = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    expect(database.query("SELECT count(*) AS count FROM kojo_workflow_runs").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT count(*) AS count FROM kojo_execution_events").get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});

it("expires a CLI Plan Key at exactly fifteen minutes", async () => {
  const clockDirectory = await makeTemporaryDirectory("kojo-deletion-clock-");
  cleanups.push(clockDirectory.cleanup);
  const clockPath = join(clockDirectory.path, "now");
  await writeFile(clockPath, "1000");
  const { host, identity, project } = await setupProject(unscheduledConfiguration, {
    deletionClockPath: clockPath,
  });

  const preview = await runKojoCli(
    ["delete", "project", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(preview.exitCode, `${preview.stdout}${preview.stderr}`).toBe(0);
  const plan = readJson(preview.stdout).result.preview;
  expect(plan.observedAtMs).toBe(1000);
  expect(plan.expiresAtMs).toBe(1000 + 15 * 60 * 1_000);

  await writeFile(clockPath, String(plan.expiresAtMs));
  const expired = await runKojoCli(
    ["delete", "project", "--project-id", identity, "--plan-key", plan.planKey, "--json"],
    host.socketPath,
    project,
  );
  expect(expired.exitCode).toBe(4);
  expect(readJson(expired.stdout).error.code).toBe("plan-expired");
});

it("deletes only final occurrences before the boundary and rejects wildcard selection", async () => {
  const { host, identity, project } = await setupProject(scheduledConfiguration);
  const listed = await runKojoCli(
    ["schedule", "list", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  const revision = readJson(listed.stdout).result[0].definition.revision as string;
  const scheduledAtMs = Date.parse("2025-01-01T09:00:00.000Z");
  const database = new Database(join(project, ".kojo", "kojo.sqlite"), { strict: true });
  try {
    database
      .query(
        `INSERT INTO kojo_workflow_schedule_occurrences(
          schedule_key, scheduled_at_ms, applied_revision,
          resolved_input_encoding_version, resolved_input_schema_identity, resolved_input_json,
          resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json,
          resolved_input_sha256, outcome, reason_code, delivery_attempt_count,
          planned_at_ms, first_attempted_at_ms, processed_at_ms, row_version
        ) VALUES (?, ?, ?, 1, 'test', '{}', 1, '{}', ?, 'failed', 'test', 1, ?, ?, ?, 1)`,
      )
      .run(
        "morning-report",
        scheduledAtMs,
        revision,
        createHash("sha256").update("{}").digest(),
        scheduledAtMs,
        scheduledAtMs,
        scheduledAtMs,
      );
  } finally {
    database.close();
  }
  const wildcard = await runKojoCli(
    [
      "delete",
      "occurrence",
      "--before",
      "2025-01-02T00:00:00.000Z",
      "--schedule",
      "*",
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(wildcard.exitCode).toBe(2);

  const preview = await runKojoCli(
    [
      "delete",
      "occurrence",
      "--before",
      "2025-01-02T00:00:00.000Z",
      "--schedule",
      "morning-report",
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(preview.exitCode, `${preview.stdout}${preview.stderr}`).toBe(0);
  const previewResult = readJson(preview.stdout).result.preview;
  expect(previewResult.counts.occurrences).toBe(1);
  const confirmed = await runKojoCli(
    [
      "delete",
      "occurrence",
      "--before",
      "2025-01-02T00:00:00.000Z",
      "--schedule",
      "morning-report",
      "--project-id",
      identity,
      "--plan-key",
      previewResult.planKey,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(confirmed.exitCode, `${confirmed.stdout}${confirmed.stderr}`).toBe(0);
  const remaining = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    expect(
      remaining.query("SELECT count(*) AS count FROM kojo_workflow_schedule_occurrences").get(),
    ).toEqual({ count: 0 });
  } finally {
    remaining.close();
  }
});

it("requires an unavailable disabled Schedule and removes its operational history", async () => {
  const { host, identity, project } = await setupProject(scheduledConfiguration);
  const listed = await runKojoCli(
    ["schedule", "list", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  const revision = readJson(listed.stdout).result[0].definition.revision as string;
  const disabled = await runKojoCli(
    [
      "schedule",
      "disable",
      "morning-report",
      "--request-key",
      "disable-before-deletion",
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(disabled.exitCode, `${disabled.stdout}${disabled.stderr}`).toBe(0);

  const notUnavailable = await runKojoCli(
    ["delete", "schedule", "morning-report", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(notUnavailable.exitCode).toBe(4);
  expect(readJson(notUnavailable.stdout).error.code).toBe("schedule-not-unavailable");

  await writeFile(join(project, "kojo.config.ts"), unavailableScheduleConfiguration);
  const unavailable = await runKojoCli(
    ["schedule", "list", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(unavailable.exitCode, `${unavailable.stdout}${unavailable.stderr}`).toBe(0);
  expect(readJson(unavailable.stdout).result[0]).toMatchObject({
    enabledIntent: false,
    condition: "unavailable",
  });

  const scheduledAtMs = Date.parse("2025-01-01T09:00:00.000Z");
  const database = new Database(join(project, ".kojo", "kojo.sqlite"), { strict: true });
  try {
    database
      .query(
        `INSERT INTO kojo_workflow_schedule_occurrences(
          schedule_key, scheduled_at_ms, applied_revision,
          resolved_input_encoding_version, resolved_input_schema_identity, resolved_input_json,
          resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json,
          resolved_input_sha256, outcome, reason_code, delivery_attempt_count,
          planned_at_ms, first_attempted_at_ms, processed_at_ms, row_version
        ) VALUES (?, ?, ?, 1, 'test', '{}', 1, '{}', ?, 'failed', 'test', 1, ?, ?, ?, 1)`,
      )
      .run(
        "morning-report",
        scheduledAtMs,
        revision,
        createHash("sha256").update("{}").digest(),
        scheduledAtMs,
        scheduledAtMs,
        scheduledAtMs,
      );
  } finally {
    database.close();
  }

  const preview = await runKojoCli(
    ["delete", "schedule", "morning-report", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(preview.exitCode, `${preview.stdout}${preview.stderr}`).toBe(0);
  const previewResult = readJson(preview.stdout).result.preview;
  expect(previewResult.counts.schedules).toBe(1);
  expect(previewResult.counts.occurrences).toBe(1);

  const confirmed = await runKojoCli(
    [
      "delete",
      "schedule",
      "morning-report",
      "--project-id",
      identity,
      "--plan-key",
      previewResult.planKey,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(confirmed.exitCode, `${confirmed.stdout}${confirmed.stderr}`).toBe(0);
  const remaining = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    expect(
      remaining.query("SELECT count(*) AS count FROM kojo_workflow_schedule_states").get(),
    ).toEqual({ count: 0 });
    expect(
      remaining.query("SELECT count(*) AS count FROM kojo_workflow_schedule_occurrences").get(),
    ).toEqual({ count: 0 });
  } finally {
    remaining.close();
  }
});

it("prunes a linked final occurrence without deleting its retained Run", async () => {
  const { host, identity, project } = await setupProject(scheduledConfiguration);
  const started = await runKojoCli(
    [
      "run",
      "start",
      "echo",
      "--input",
      '{"message":"retained-run"}',
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = readJson(started.stdout).result.run.runId as string;
  await waitForFinalRun(host.socketPath, project, runId);
  const listed = await runKojoCli(
    ["schedule", "list", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(listed.exitCode, `${listed.stdout}${listed.stderr}`).toBe(0);
  const scheduledAtMs = Date.parse("2025-01-01T09:00:00.000Z");
  const database = new Database(join(project, ".kojo", "kojo.sqlite"), { strict: true });
  try {
    database
      .query(
        `INSERT INTO kojo_workflow_schedule_occurrences(
          schedule_key, scheduled_at_ms, applied_revision,
          resolved_input_encoding_version, resolved_input_schema_identity, resolved_input_json,
          resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json,
          resolved_input_sha256, outcome, reason_code, delivery_attempt_count,
          planned_at_ms, first_attempted_at_ms, processed_at_ms, linked_run_id, row_version
        ) VALUES (?, ?, ?, 1, 'test', '{}', 1, '{}', ?, 'started', 'test', 1, ?, ?, ?, ?, 1)`,
      )
      .run(
        "morning-report",
        scheduledAtMs,
        "1",
        createHash("sha256").update("{}").digest(),
        scheduledAtMs,
        scheduledAtMs,
        scheduledAtMs,
        runId,
      );
  } finally {
    database.close();
  }

  const preview = await runKojoCli(
    [
      "delete",
      "occurrence",
      "--before",
      "2025-01-02T00:00:00.000Z",
      "--schedule",
      "morning-report",
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(preview.exitCode, `${preview.stdout}${preview.stderr}`).toBe(0);
  const previewResult = readJson(preview.stdout).result.preview;
  expect(previewResult.counts.occurrences).toBe(1);
  const confirmed = await runKojoCli(
    [
      "delete",
      "occurrence",
      "--before",
      "2025-01-02T00:00:00.000Z",
      "--schedule",
      "morning-report",
      "--project-id",
      identity,
      "--plan-key",
      previewResult.planKey,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(confirmed.exitCode, `${confirmed.stdout}${confirmed.stderr}`).toBe(0);
  const remaining = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    expect(
      remaining.query("SELECT count(*) AS count FROM kojo_workflow_schedule_occurrences").get(),
    ).toEqual({ count: 0 });
    expect(
      remaining
        .query("SELECT count(*) AS count FROM kojo_workflow_runs WHERE run_id = ?")
        .get(runId),
    ).toEqual({ count: 1 });
  } finally {
    remaining.close();
  }
});

it("rejects Run and Project previews while execution is not final", async () => {
  const { host, identity, project } = await setupProject(runningConfiguration);
  const started = await runKojoCli(
    [
      "run",
      "start",
      "hold",
      "--input",
      '{"message":"still-running"}',
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = readJson(started.stdout).result.run.runId as string;

  const runPreview = await runKojoCli(
    ["delete", "run", runId, "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(runPreview.exitCode).toBe(4);
  expect(readJson(runPreview.stdout).error.code).toBe("target-not-final");

  const projectPreview = await runKojoCli(
    ["delete", "project", "--project-id", identity, "--json"],
    host.socketPath,
    project,
  );
  expect(projectPreview.exitCode).toBe(4);
  expect(readJson(projectPreview.stdout).error.code).toBe("project-runs-not-final");

  const stopped = await runKojoCli(
    [
      "run",
      "stop",
      runId,
      "--request-key",
      "stop-before-deletion-preview",
      "--project-id",
      identity,
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(stopped.exitCode, `${stopped.stdout}${stopped.stderr}`).toBe(0);
});

it("resumes the same confirmed Project deletion after a crash at every ordered phase", {
  timeout: 120_000,
}, async () => {
  const phases = [
    "quiescing",
    "clearing-engine",
    "clearing-owned-content",
    "deleting-records",
  ] as const;

  for (const phase of phases) {
    const hostStore = await makeTemporaryDirectory(`kojo-deletion-crash-${phase}-`);
    cleanups.push(() => tolerateMissingCleanup(hostStore.cleanup));
    const { host, identity, project } = await setupProject(scheduledConfiguration, {
      deletionCrashPhase: phase,
      storePath: hostStore.path,
    });
    const started = await runKojoCli(
      [
        "run",
        "start",
        "echo",
        "--input",
        '{"message":"crash-window"}',
        "--project-id",
        identity,
        "--json",
      ],
      host.socketPath,
      project,
    );
    expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
    const runId = readJson(started.stdout).result.run.runId as string;
    await waitForFinalRun(host.socketPath, project, runId);
    const schedules = await runKojoCli(
      ["schedule", "list", "--project-id", identity, "--json"],
      host.socketPath,
      project,
    );
    expect(schedules.exitCode, `${schedules.stdout}${schedules.stderr}`).toBe(0);
    const ownedFile = join(project, ".kojo", "sandboxes", "crash-window.txt");
    await mkdir(join(project, ".kojo", "sandboxes"), { recursive: true });
    await writeFile(ownedFile, `owned content for ${phase}`);

    const preview = await runKojoCli(
      ["delete", "project", "--project-id", identity, "--json"],
      host.socketPath,
      project,
    );
    expect(preview.exitCode, `${preview.stdout}${preview.stderr}`).toBe(0);
    const plan = readJson(preview.stdout).result.preview;
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "run", key: `run:${runId}` }),
        expect.objectContaining({
          kind: "owned-file",
          key: "file:.kojo/sandboxes/crash-window.txt",
        }),
      ]),
    );

    const crashed = await runKojoCli(
      ["delete", "project", "--project-id", identity, "--plan-key", plan.planKey, "--json"],
      host.socketPath,
      project,
    );
    expect(crashed.exitCode).not.toBe(0);
    await host.crash();

    const interrupted = new Database(join(project, ".kojo", "kojo.sqlite"), {
      readonly: true,
      strict: true,
    });
    try {
      expect(
        interrupted
          .query(
            "SELECT state, phase FROM kojo_control_requests JOIN kojo_deletion_intents USING(request_key) WHERE request_key = ?",
          )
          .get(plan.planKey),
      ).toEqual({ state: "pending", phase });
      expect(
        interrupted
          .query(
            "SELECT enabled_intent, condition FROM kojo_workflow_schedule_states WHERE schedule_key = 'morning-report'",
          )
          .get(),
      ).toEqual({ enabled_intent: 0, condition: "unavailable" });
    } finally {
      interrupted.close();
    }

    const recoveredHost = await startKojoHostProcess({ storePath: hostStore.path });
    cleanups.push(recoveredHost.stop);
    const replay = await runKojoCli(
      ["delete", "project", "--project-id", identity, "--plan-key", plan.planKey, "--json"],
      recoveredHost.socketPath,
      project,
    );
    expect(replay.exitCode, `${replay.stdout}${replay.stderr}`).toBe(0);
    expect(readJson(replay.stdout).result.receipt).toMatchObject({
      requestKey: plan.planKey,
      version: 1,
    });
    expect(await fileExists(ownedFile)).toBe(false);

    const completed = new Database(join(project, ".kojo", "kojo.sqlite"), {
      readonly: true,
      strict: true,
    });
    try {
      expect(
        completed
          .query("SELECT state, target_kind FROM kojo_control_requests WHERE request_key = ?")
          .get(plan.planKey),
      ).toEqual({ state: "completed", target_kind: "none" });
      expect(completed.query("SELECT count(*) AS count FROM kojo_deletion_intents").get()).toEqual({
        count: 0,
      });
      expect(completed.query("SELECT count(*) AS count FROM kojo_workflow_runs").get()).toEqual({
        count: 0,
      });
    } finally {
      completed.close();
    }
  }
});
