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
      database.query("SELECT count(*) AS count FROM kojo_workflow_schedule_occurrences").get(),
    ).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM kojo_workflow_runs").get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});
