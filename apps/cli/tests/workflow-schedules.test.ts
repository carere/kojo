import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSystemStore } from "../src/system/storage";
import { makeWorkflowRunService } from "../src/system/workflow-runs";
import { makeWorkflowScheduleService } from "../src/system/workflow-schedules";

const homes = new Set<string>();

const makeStore = async (registrationState: "Disabled" | "Enabled" = "Enabled") => {
  const home = await mkdtemp(join(tmpdir(), "kojo-workflow-schedule-test-"));
  homes.add(home);
  const store = await openSystemStore(home);
  const now = "2026-01-01T00:00:00.000Z";
  store.projects.create({
    createdAt: now,
    id: "project-1",
    metadata: "{}",
    path: join(home, "project"),
    registrationState,
    updatedAt: now,
  });
  return store;
};

const cron = (minutes: ReadonlyArray<number>, hours: ReadonlyArray<number>) => ({
  and: false,
  days: [] as ReadonlyArray<number>,
  hours,
  minutes,
  months: [] as ReadonlyArray<number>,
  seconds: [0] as ReadonlyArray<number>,
  weekdays: [] as ReadonlyArray<number>,
});

const revision = (
  schedules: ReadonlyArray<{
    readonly cron: ReturnType<typeof cron>;
    readonly input?: unknown;
    readonly missedTimePolicy?: "catch-up-once" | "skip";
    readonly name: string;
    readonly timezone?: string;
    readonly workflow: string;
  }>,
) =>
  JSON.stringify({
    commit: "a".repeat(40),
    schedules: schedules.map((schedule) => ({
      input: {},
      missedTimePolicy: "skip",
      timezone: "UTC",
      ...schedule,
    })),
    workflows: [
      { fingerprint: "alpha-fingerprint", name: "alpha", version: "v1" },
      { fingerprint: "beta-fingerprint", name: "beta", version: "v1" },
    ],
  });

const prepared = (workflowName: string) => {
  const source = {
    commit: "a".repeat(40),
    dirty: false,
    kind: "ProjectSourceRevision" as const,
  };
  return {
    encodedInput: { fixed: true },
    execute: async () => new Promise<never>(() => undefined),
    revision: {
      declaredVersion: "v1",
      fingerprint: `${workflowName}-fingerprint`,
      source,
      stableName: workflowName,
      workflowAbi: "1",
    },
    revisionSnapshot: {
      rootWorkflow: workflowName,
      source,
      workflows: [
        {
          declaredVersion: "v1",
          fingerprint: `${workflowName}-fingerprint`,
          stableName: workflowName,
          workflowAbi: "1",
        },
      ],
    },
  };
};

afterEach(async () => {
  for (const home of homes) await rm(home, { force: true, recursive: true });
  homes.clear();
});

describe("durable Workflow Schedules", () => {
  test("discovers Schedules as Disabled and preserves identity without allowing retargeting", async () => {
    const store = await makeStore();
    store.projectSources.activate(
      "project-1",
      "LocalWithFreshnessWarning",
      revision([{ cron: cron([0], [9]), name: "morning", workflow: "alpha" }]),
    );

    expect(store.workflowSchedules.list("project-1")).toEqual([
      expect.objectContaining({
        enablement: "Disabled",
        name: "morning",
        workflowName: "alpha",
      }),
    ]);

    expect(() =>
      store.projectSources.activate(
        "project-1",
        "LocalWithFreshnessWarning",
        revision([{ cron: cron([0], [9]), name: "morning", workflow: "beta" }]),
      ),
    ).toThrow("cannot be retargeted");

    expect(store.workflowSchedules.list("project-1")[0]).toMatchObject({
      activeDefinition: expect.any(String),
      workflowName: "alpha",
    });
    store.close();
  });

  test("does not accumulate missed times while either the Schedule or Project is Disabled", async () => {
    const store = await makeStore("Disabled");
    store.projectSources.activate(
      "project-1",
      "LocalWithFreshnessWarning",
      revision([
        {
          cron: cron([], []),
          missedTimePolicy: "catch-up-once",
          name: "every-minute",
          workflow: "alpha",
        },
      ]),
    );
    const runs = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => prepared(workflowName),
    });
    const schedules = makeWorkflowScheduleService(store, runs);

    schedules.enable("project-1", "every-minute", new Date("2026-01-01T09:00:00.000Z"));
    await schedules.evaluate(new Date("2026-01-01T09:05:00.000Z"));
    expect(schedules.inspect("project-1", "every-minute")).toMatchObject({
      catchUp: null,
      cursor: "2026-01-01T09:05:00.000Z",
      history: [],
    });

    store.projects.update("project-1", { registrationState: "Enabled" });
    schedules.disable("project-1", "every-minute");
    await schedules.evaluate(new Date("2026-01-01T09:10:00.000Z"));
    expect(schedules.inspect("project-1", "every-minute")).toMatchObject({
      catchUp: null,
      cursor: "2026-01-01T09:05:00.000Z",
      history: [],
    });
    store.close();
  });

  test("coalesces downtime once and atomically creates one scheduled root run", async () => {
    const store = await makeStore();
    store.projectSources.activate(
      "project-1",
      "LocalWithFreshnessWarning",
      revision([
        {
          cron: cron([], []),
          input: { fixed: true },
          missedTimePolicy: "catch-up-once",
          name: "minute-alpha",
          workflow: "alpha",
        },
      ]),
    );
    const runs = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => prepared(workflowName),
    });
    const schedules = makeWorkflowScheduleService(store, runs);
    schedules.enable("project-1", "minute-alpha", new Date("2026-01-01T09:00:00.000Z"));

    await schedules.evaluate(new Date("2026-01-01T09:03:00.000Z"));
    await schedules.evaluate(new Date("2026-01-01T09:03:00.000Z"));

    const rootRuns = store.workflowRuns.list();
    expect(rootRuns).toHaveLength(1);
    expect(JSON.parse(rootRuns[0]?.trigger ?? "null")).toMatchObject({
      catchUp: {
        count: 3,
        earliest: "2026-01-01T09:01:00.000Z",
        latest: "2026-01-01T09:03:00.000Z",
      },
      occurrence: "2026-01-01T09:01:00.000Z",
      scheduleName: "minute-alpha",
      type: "Scheduled",
    });
    expect(schedules.inspect("project-1", "minute-alpha")).toMatchObject({
      catchUp: null,
      cursor: "2026-01-01T09:03:00.000Z",
      history: [expect.objectContaining({ outcome: "Started", runId: rootRuns[0]?.runId })],
      occurrences: [
        expect.objectContaining({ scheduledAt: "2026-01-01T09:01:00.000Z" }),
        expect.objectContaining({ scheduledAt: "2026-01-01T09:02:00.000Z" }),
        expect.objectContaining({ scheduledAt: "2026-01-01T09:03:00.000Z" }),
      ],
    });
    expect(runs.inspect(rootRuns[0]?.runId ?? "")).toMatchObject({
      evidence: [{ type: "WorkflowRun.Started" }],
      trigger: { scheduleName: "minute-alpha", type: "Scheduled" },
    });
    store.close();
  });

  test("creates no run before successful preflight and retries one durable catch-up", async () => {
    const store = await makeStore();
    store.projectSources.activate(
      "project-1",
      "LocalWithFreshnessWarning",
      revision([
        {
          cron: cron([], []),
          missedTimePolicy: "catch-up-once",
          name: "retry-preflight",
          workflow: "alpha",
        },
      ]),
    );
    let available = false;
    const runs = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => {
        if (!available) throw new Error("source validation failed");
        return prepared(workflowName);
      },
    });
    const schedules = makeWorkflowScheduleService(store, runs);
    schedules.enable("project-1", "retry-preflight", new Date("2026-01-01T09:00:00.000Z"));

    await schedules.evaluate(new Date("2026-01-01T09:02:00.000Z"));
    expect(store.workflowRuns.list()).toEqual([]);
    expect(schedules.inspect("project-1", "retry-preflight")).toMatchObject({
      catchUp: {
        count: 2,
        earliest: "2026-01-01T09:01:00.000Z",
        latest: "2026-01-01T09:02:00.000Z",
      },
      history: [expect.objectContaining({ outcome: "PreflightFailed", runId: null })],
      occurrences: [
        expect.objectContaining({ scheduledAt: "2026-01-01T09:01:00.000Z" }),
        expect.objectContaining({ scheduledAt: "2026-01-01T09:02:00.000Z" }),
      ],
    });

    available = true;
    await schedules.evaluate(new Date("2026-01-01T09:02:00.000Z"));
    expect(store.workflowRuns.list()).toHaveLength(1);
    expect(schedules.inspect("project-1", "retry-preflight")).toMatchObject({
      catchUp: null,
      history: [
        expect.objectContaining({ outcome: "PreflightFailed" }),
        expect.objectContaining({ outcome: "Started" }),
      ],
      occurrences: [
        expect.objectContaining({ scheduledAt: "2026-01-01T09:01:00.000Z" }),
        expect.objectContaining({ scheduledAt: "2026-01-01T09:02:00.000Z" }),
      ],
    });
    store.close();
  });

  test("uses oldest-time then name ordering and only Running roots suppress overlap", async () => {
    const store = await makeStore();
    store.projectSources.activate(
      "project-1",
      "LocalWithFreshnessWarning",
      revision([
        { cron: cron([], []), name: "beta-first", workflow: "alpha" },
        { cron: cron([], []), name: "alpha-second", workflow: "alpha" },
      ]),
    );
    const runs = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => prepared(workflowName),
    });
    const schedules = makeWorkflowScheduleService(store, runs);
    schedules.enable("project-1", "beta-first", new Date("2026-01-01T08:59:00.000Z"));
    schedules.enable("project-1", "alpha-second", new Date("2026-01-01T09:00:00.000Z"));

    await schedules.evaluate(new Date("2026-01-01T09:01:00.000Z"));

    expect(store.workflowRuns.list()).toHaveLength(1);
    expect(
      schedules.inspect("project-1", "beta-first").history.map(({ outcome }) => outcome),
    ).toEqual(["Skipped", "Started"]);
    expect(schedules.inspect("project-1", "alpha-second").history[0]).toMatchObject({
      outcome: "SkippedOverlap",
    });

    const started = store.workflowRuns.list()[0];
    if (started === undefined) throw new Error("scheduled start was not created");
    store.workflowRuns.discard(started.runId);
    await schedules.evaluate(new Date("2026-01-01T09:02:00.000Z"));
    expect(store.workflowRuns.list()).toHaveLength(2);
    store.close();
  });

  test("keeps the cursor monotonic across a backward clock shift", async () => {
    const store = await makeStore();
    store.projectSources.activate(
      "project-1",
      "LocalWithFreshnessWarning",
      revision([{ cron: cron([30], []), name: "half-hour", workflow: "alpha" }]),
    );
    const runs = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => prepared(workflowName),
    });
    const schedules = makeWorkflowScheduleService(store, runs);
    schedules.enable("project-1", "half-hour", new Date("2026-10-25T00:00:00.000Z"));
    await schedules.evaluate(new Date("2026-10-25T02:30:00.000Z"));
    const before = schedules.inspect("project-1", "half-hour");

    await schedules.evaluate(new Date("2026-10-25T01:30:00.000Z"));

    const after = schedules.inspect("project-1", "half-hour");
    expect(after.cursor).toBe(before.cursor);
    expect(after.occurrences).toEqual(before.occurrences);
    store.close();
  });

  test("fires a daylight-saving fold once at its earlier instant and moves a gap forward", async () => {
    const store = await makeStore();
    store.projectSources.activate(
      "project-1",
      "LocalWithFreshnessWarning",
      revision([
        {
          cron: cron([30], [1]),
          name: "fold",
          timezone: "America/New_York",
          workflow: "alpha",
        },
        {
          cron: cron([30], [2]),
          name: "gap",
          timezone: "America/New_York",
          workflow: "beta",
        },
      ]),
    );
    const runs = makeWorkflowRunService(store, {
      prepare: async ({ workflowName }) => prepared(workflowName),
    });
    const schedules = makeWorkflowScheduleService(store, runs);

    schedules.enable("project-1", "fold", new Date("2026-11-01T04:00:00.000Z"));
    await schedules.evaluate(new Date("2026-11-01T07:00:00.000Z"));
    expect(
      schedules.inspect("project-1", "fold").occurrences.map(({ scheduledAt }) => scheduledAt),
    ).toEqual(["2026-11-01T05:30:00.000Z"]);

    store.workflowRuns.discard(store.workflowRuns.list()[0]?.runId ?? "");
    schedules.enable("project-1", "gap", new Date("2026-03-08T05:00:00.000Z"));
    await schedules.evaluate(new Date("2026-03-08T08:00:00.000Z"));
    expect(
      schedules.inspect("project-1", "gap").occurrences.map(({ scheduledAt }) => scheduledAt),
    ).toEqual(["2026-03-08T07:30:00.000Z"]);
    store.close();
  });
});
