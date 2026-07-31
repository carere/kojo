import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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

const configuration = (cron: string) => `
import { Effect, Schema } from "effect";
import { defineConfig, defineWorkflow } from "@kojo/workflow";

const input = Schema.Struct({ kind: Schema.String });
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "report",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      schedules: [{
        scheduleKey: "morning-report",
        workflowKey: "report",
        cron: ${JSON.stringify(cron)},
        timeZone: "Europe/Paris",
        overlap: "skip",
        input: {
          revision: "input-v1",
          resolve: ({ scheduleKey, scheduledAt }) => ({ kind: scheduleKey + ":" + scheduledAt.toISOString() })
        }
      }],
      handler: ({ kind }) => Effect.succeed(kind)
    })
  ]
});
`;

it("reconciles and controls durable Workflow Schedules without starting an occurrence", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-schedules-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration("0 9 * * 1-5"));
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);

  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  const listed = await runKojoCli(["schedule", "list", "--json"], host.socketPath, project);
  expect(listed.exitCode, `${listed.stdout}${listed.stderr}`).toBe(0);
  const initial = JSON.parse(listed.stdout).result[0];
  expect(initial).toMatchObject({
    scheduleKey: "morning-report",
    enabledIntent: false,
    condition: "available",
    nextOccurrenceMs: null,
    definition: {
      workflowKey: "report",
      cron: "0 9 * * 1-5",
      timeZone: "Europe/Paris",
      overlapPolicy: "skip",
      inputRuleRevision: "input-v1",
    },
  });
  const initialHumanList = await runKojoCli(
    ["schedule", "list", "--workflow", "report", "--condition", "available"],
    host.socketPath,
    project,
  );
  expect(initialHumanList.exitCode, `${initialHumanList.stdout}${initialHumanList.stderr}`).toBe(0);
  expect(initialHumanList.stdout).toMatch(
    /^morning-report\tdisabled\tavailable\treport\t[^\t]+\t-\n$/,
  );

  const enabled = await runKojoCli(
    [
      "schedule",
      "enable",
      "morning-report",
      "--revision",
      initial.definition.revision,
      "--request-key",
      "enable-morning-report",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(enabled.exitCode, `${enabled.stdout}${enabled.stderr}`).toBe(0);
  expect(JSON.parse(enabled.stdout).result).toMatchObject({
    alreadyApplied: false,
    schedule: { enabledIntent: true, nextOccurrenceMs: expect.any(Number) },
  });
  const replayedEnable = await runKojoCli(
    [
      "schedule",
      "enable",
      "morning-report",
      "--revision",
      initial.definition.revision,
      "--request-key",
      "enable-morning-report",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(replayedEnable.exitCode, `${replayedEnable.stdout}${replayedEnable.stderr}`).toBe(0);
  expect(JSON.parse(replayedEnable.stdout).result.alreadyApplied).toBe(true);
  const next = await runKojoCli(["schedule", "next", "--json"], host.socketPath, project);
  expect(next.exitCode, `${next.stdout}${next.stderr}`).toBe(0);
  expect(JSON.parse(next.stdout).result).toHaveLength(1);
  const nextHumanList = await runKojoCli(
    ["schedule", "next", "--workflow", "report", "--condition", "available"],
    host.socketPath,
    project,
  );
  expect(nextHumanList.exitCode, `${nextHumanList.stdout}${nextHumanList.stderr}`).toBe(0);
  expect(nextHumanList.stdout).toMatch(
    /^morning-report\tenabled\tavailable\treport\t[^\t]+\t\d{4}-\d{2}-\d{2}T.+Z\n$/,
  );

  await writeFile(join(project, "kojo.config.ts"), configuration("30 9 * * 1-5"));
  const changed = await runKojoCli(
    ["schedule", "show", "morning-report", "--json"],
    host.socketPath,
    project,
  );
  expect(changed.exitCode, `${changed.stdout}${changed.stderr}`).toBe(0);
  const changedSchedule = JSON.parse(changed.stdout).result.schedule;
  expect(changedSchedule.definition.revision).not.toBe(initial.definition.revision);
  const stale = await runKojoCli(
    [
      "schedule",
      "enable",
      "morning-report",
      "--revision",
      initial.definition.revision,
      "--request-key",
      "stale-enable",
      "--json",
    ],
    host.socketPath,
    project,
  );
  expect(stale.exitCode).toBe(4);
  expect(JSON.parse(stale.stdout).error).toMatchObject({
    code: "schedule-revision-conflict",
    currentSchedule: { definition: { revision: changedSchedule.definition.revision } },
  });

  const [racedEnable, racedDisable] = await Promise.all([
    runKojoCli(
      [
        "schedule",
        "enable",
        "morning-report",
        "--revision",
        changedSchedule.definition.revision,
        "--request-key",
        "enable-race",
        "--json",
      ],
      host.socketPath,
      project,
    ),
    runKojoCli(
      ["schedule", "disable", "morning-report", "--request-key", "disable-race", "--json"],
      host.socketPath,
      project,
    ),
  ]);
  expect(racedEnable.exitCode, `${racedEnable.stdout}${racedEnable.stderr}`).toBe(0);
  expect(racedDisable.exitCode, `${racedDisable.stdout}${racedDisable.stderr}`).toBe(0);

  const disabled = await runKojoCli(
    ["schedule", "disable", "morning-report", "--request-key", "disable-final", "--json"],
    host.socketPath,
    project,
  );
  expect(disabled.exitCode, `${disabled.stdout}${disabled.stderr}`).toBe(0);
  expect(JSON.parse(disabled.stdout).result).toMatchObject({
    acceptedRunsContinue: true,
    schedule: { enabledIntent: false, nextOccurrenceMs: null },
  });
  const replayedDisable = await runKojoCli(
    ["schedule", "disable", "morning-report", "--request-key", "disable-final", "--json"],
    host.socketPath,
    project,
  );
  expect(replayedDisable.exitCode, `${replayedDisable.stdout}${replayedDisable.stderr}`).toBe(0);
  expect(JSON.parse(replayedDisable.stdout).result.alreadyApplied).toBe(true);

  const database = new Database(join(project, ".kojo", "kojo.sqlite"), {
    readonly: true,
    strict: true,
  });
  try {
    expect(
      database
        .query(
          "SELECT outcome, reason_code AS reasonCode, count(*) AS count FROM kojo_workflow_schedule_occurrences GROUP BY outcome, reason_code",
        )
        .all(),
    ).toEqual([{ outcome: "invalidated", reasonCode: "schedule.disabled", count: 1 }]);
    expect(database.query("SELECT count(*) AS count FROM kojo_workflow_runs").get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});

it("delivers one persisted occurrence after Host restart and preserves its linked Run on redelivery", async () => {
  const directory = await makeTemporaryDirectory("kojo-scheduled-occurrence-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  const hostStore = join(directory.path, "host");
  await initializeGit(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), configuration("* * * * *"));

  const firstHost = await startKojoHostProcess({ storePath: hostStore });
  expect((await runKojoCli(["init", project], firstHost.socketPath)).exitCode).toBe(0);
  const listed = await runKojoCli(["schedule", "list", "--json"], firstHost.socketPath, project);
  const revision = JSON.parse(listed.stdout).result[0].definition.revision as string;
  expect(
    (
      await runKojoCli(
        [
          "schedule",
          "enable",
          "morning-report",
          "--revision",
          revision,
          "--request-key",
          "enable-restart-proof",
          "--json",
        ],
        firstHost.socketPath,
        project,
      )
    ).exitCode,
  ).toBe(0);
  const databasePath = join(project, ".kojo", "kojo.sqlite");
  await waitFor(() => occurrenceCount(databasePath) === 1);
  await firstHost.stop();

  const scheduledAtMs = Date.now() - 1_000;
  const expectedInput = { kind: `morning-report:${new Date(scheduledAtMs).toISOString()}` };
  const database = new Database(databasePath, { strict: true });
  try {
    const current = database
      .query(
        `SELECT scheduled_at_ms AS scheduledAtMs, applied_revision AS appliedRevision,
          outcome, delivery_attempt_count AS deliveryAttemptCount
         FROM kojo_workflow_schedule_occurrences
         WHERE schedule_key = 'morning-report' AND outcome = 'planned'`,
      )
      .get() as {
      readonly appliedRevision: string;
      readonly deliveryAttemptCount: number;
      readonly outcome: string;
      readonly scheduledAtMs: number;
    };
    expect(current).toMatchObject({
      appliedRevision: revision,
      deliveryAttemptCount: 0,
      outcome: "planned",
    });
    expect(current.scheduledAtMs).toBeGreaterThan(Date.now());
    database
      .query(
        "UPDATE kojo_workflow_schedule_occurrences SET scheduled_at_ms = ?, resolved_input_json = ? WHERE schedule_key = 'morning-report' AND scheduled_at_ms = ?",
      )
      .run(scheduledAtMs, JSON.stringify(expectedInput), current.scheduledAtMs);
    database
      .query(
        "UPDATE kojo_workflow_schedule_states SET next_occurrence_ms = ? WHERE schedule_key = 'morning-report'",
      )
      .run(scheduledAtMs);
  } finally {
    database.close();
  }

  const restarted = await startKojoHostProcess({ storePath: hostStore });
  cleanups.push(restarted.stop);
  await waitFor(() => scheduledRunCount(databasePath) === 1, 10_000);
  const occurrence = readOccurrenceAndRun(databasePath);
  expect(occurrence).toMatchObject({
    outcome: "started",
    linkedRunId: expect.any(String),
    triggerKind: "schedule",
    scheduleKey: "morning-report",
    scheduledAtMs,
  });
  expect(JSON.parse(occurrence.startSnapshot)).toMatchObject({
    input: expectedInput,
    trigger: {
      kind: "schedule",
      requestKey: `schedule:${createHash("sha256")
        .update(`morning-report\u0000${scheduledAtMs}`)
        .digest("hex")}`,
      scheduleKey: "morning-report",
      occurrence: { scheduleKey: "morning-report", scheduledAtMs },
      scheduledAtMs,
      scheduleRevision: revision,
    },
  });
  expect(plannedFutureOccurrenceCount(databasePath)).toBe(1);

  const occurrences = await runKojoCli(
    ["occurrence", "list", "--json"],
    restarted.socketPath,
    project,
  );
  expect(occurrences.exitCode, `${occurrences.stdout}${occurrences.stderr}`).toBe(0);
  expect(JSON.parse(occurrences.stdout).result).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        scheduleKey: "morning-report",
        scheduledAtMs,
        outcome: "started",
        linkedRunId: occurrence.linkedRunId,
      }),
    ]),
  );
  const shownOccurrence = await runKojoCli(
    ["occurrence", "show", "morning-report", new Date(scheduledAtMs).toISOString(), "--json"],
    restarted.socketPath,
    project,
  );
  expect(shownOccurrence.exitCode, `${shownOccurrence.stdout}${shownOccurrence.stderr}`).toBe(0);
  expect(JSON.parse(shownOccurrence.stdout).result.occurrence).toMatchObject({
    scheduleKey: "morning-report",
    scheduledAtMs,
    outcome: "started",
    linkedRunId: occurrence.linkedRunId,
  });
  const linkedSchedule = await runKojoCli(
    ["schedule", "show", "morning-report", "--json"],
    restarted.socketPath,
    project,
  );
  expect(linkedSchedule.exitCode, `${linkedSchedule.stdout}${linkedSchedule.stderr}`).toBe(0);
  const linkedRun = await runKojoCli(
    ["run", "show", occurrence.linkedRunId, "--json"],
    restarted.socketPath,
    project,
  );
  expect(linkedRun.exitCode, `${linkedRun.stdout}${linkedRun.stderr}`).toBe(0);
  expect(JSON.parse(linkedRun.stdout).result.run.runId).toBe(occurrence.linkedRunId);
  const disabledAfterAcceptance = await runKojoCli(
    [
      "schedule",
      "disable",
      "morning-report",
      "--request-key",
      "disable-after-occurrence-start",
      "--json",
    ],
    restarted.socketPath,
    project,
  );
  expect(
    disabledAfterAcceptance.exitCode,
    `${disabledAfterAcceptance.stdout}${disabledAfterAcceptance.stderr}`,
  ).toBe(0);
  expect(JSON.parse(disabledAfterAcceptance.stdout).result.schedule.enabledIntent).toBe(false);
  expect(scheduledRunCount(databasePath)).toBe(1);
  expect(readOccurrenceAndRun(databasePath).linkedRunId).toBe(occurrence.linkedRunId);

  await restarted.stop();
  markSubmissionPending(databasePath, occurrence.linkedRunId);
  const redelivered = await startKojoHostProcess({ storePath: hostStore });
  cleanups.push(redelivered.stop);
  await waitFor(() => submissionState(databasePath, occurrence.linkedRunId) === "confirmed");
  expect(scheduledRunCount(databasePath)).toBe(1);
  expect(readOccurrenceAndRun(databasePath).linkedRunId).toBe(occurrence.linkedRunId);
}, 20_000);

const occurrenceCount = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database.query("SELECT count(*) AS count FROM kojo_workflow_schedule_occurrences").get() as {
        readonly count: number;
      }
    ).count;
  } finally {
    database.close();
  }
};

const scheduledRunCount = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query("SELECT count(*) AS count FROM kojo_workflow_runs WHERE trigger_kind = 'schedule'")
        .get() as {
        readonly count: number;
      }
    ).count;
  } finally {
    database.close();
  }
};

const plannedFutureOccurrenceCount = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query(
          "SELECT count(*) AS count FROM kojo_workflow_schedule_occurrences WHERE outcome = 'planned' AND scheduled_at_ms > ?",
        )
        .get(Date.now()) as { readonly count: number }
    ).count;
  } finally {
    database.close();
  }
};

const markSubmissionPending = (databasePath: string, runId: string) => {
  const database = new Database(databasePath, { strict: true });
  try {
    database
      .query(
        `UPDATE kojo_engine_operations
         SET state = 'pending', confirmed_at_ms = NULL, confirmation_event_id = NULL,
           next_attempt_at_ms = ?, updated_at_ms = ?
         WHERE run_id = ? AND kind = 'submit'`,
      )
      .run(Date.now(), Date.now(), runId);
  } finally {
    database.close();
  }
};

const submissionState = (databasePath: string, runId: string) => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database
        .query("SELECT state FROM kojo_engine_operations WHERE run_id = ? AND kind = 'submit'")
        .get(runId) as { readonly state: string }
    ).state;
  } finally {
    database.close();
  }
};

const readOccurrenceAndRun = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return database
      .query(
        `SELECT occurrence.outcome, occurrence.linked_run_id AS linkedRunId,
          run.trigger_kind AS triggerKind, run.schedule_key AS scheduleKey,
          run.scheduled_at_ms AS scheduledAtMs, event.payload_json AS startSnapshot
         FROM kojo_workflow_schedule_occurrences occurrence
         JOIN kojo_workflow_runs run ON run.run_id = occurrence.linked_run_id
         JOIN kojo_execution_events event ON event.run_id = run.run_id AND event.sequence = 1
         WHERE occurrence.schedule_key = 'morning-report' AND occurrence.outcome = 'started'`,
      )
      .get() as {
      readonly linkedRunId: string;
      readonly outcome: string;
      readonly scheduleKey: string;
      readonly scheduledAtMs: number;
      readonly startSnapshot: string;
      readonly triggerKind: string;
    };
  } finally {
    database.close();
  }
};

const waitFor = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for the durable scheduled occurrence state.");
};
