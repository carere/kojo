import { describe, expect, it } from "vitest";
import {
  selectProjectDefinitionInstallCommand,
  validateProjectDefinitionInSubprocessWith,
  validateProjectDefinitionValue,
} from "../../src/project-definition-validation";

describe("shared Project Definition loader orchestration", () => {
  it.each([
    ["bun.lock", "bun add @kojo/workflow"],
    ["pnpm-lock.yaml", "pnpm add @kojo/workflow"],
    ["yarn.lock", "yarn add @kojo/workflow"],
    ["package.json", "npm install @kojo/workflow"],
  ])("selects the install command for %s", (present, expected) => {
    expect(selectProjectDefinitionInstallCommand((name) => name === present)).toBe(expected);
  });

  it("decodes the validated envelope from an application subprocess", async () => {
    const result = await validateProjectDefinitionInSubprocessWith((receive) => {
      receive({ ok: true, snapshot: { snapshotId: "test", workflows: [] } });
      return { exited: Promise.resolve(0), kill: () => undefined };
    }, 100);

    expect(result).toEqual({ ok: true, snapshot: { snapshotId: "test", workflows: [] } });
  });

  it("kills a loader that exceeds its shared deadline", async () => {
    let finish: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const result = await validateProjectDefinitionInSubprocessWith(
      () => ({
        exited,
        kill: () => finish?.(137),
      }),
      1,
    );

    expect(result).toMatchObject({ ok: false, findingKey: "configuration.load-failed" });
  });
});

it("collects every safely discoverable Workflow Definition finding", () => {
  const schema = { ast: { _tag: "StringKeyword" } };
  const validation = validateProjectDefinitionValue({
    workflows: [
      {
        workflowKey: "duplicate",
        revision: "one",
        inputSchema: schema,
        successSchema: schema,
        failureSchema: schema,
        handler: () => undefined,
        childWorkflowKeys: ["missing-child"],
      },
      {
        workflowKey: "duplicate",
        revision: "two",
        inputSchema: schema,
        successSchema: schema,
        failureSchema: schema,
        handler: () => undefined,
      },
      {
        workflowKey: "bad-schema",
        revision: "one",
        inputSchema: {},
        successSchema: schema,
        handler: () => undefined,
      },
    ],
  });

  expect(validation).toMatchObject({ ok: false });
  if (validation.ok) return;
  expect(validation.findings.map((finding) => finding.findingKey)).toEqual(
    expect.arrayContaining([
      "workflow.key-duplicate",
      "workflow.revision-conflict",
      "workflow.schema-invalid",
      "workflow.child-definition-missing",
    ]),
  );
});

it("derives stable Schedule Revisions from the complete accepted declaration", () => {
  const schema = { ast: { _tag: "StringKeyword" } };
  const schedule = {
    scheduleKey: "morning-report",
    workflowKey: "report",
    cron: "0 9 * * 1-5",
    timeZone: "Europe/Paris",
    overlap: "skip",
    input: { revision: "report-input-v1", resolve: () => "report" },
  };
  const configuration = {
    workflows: [
      {
        workflowKey: "report",
        revision: "one",
        inputSchema: schema,
        successSchema: schema,
        failureSchema: schema,
        handler: () => undefined,
        schedules: [schedule],
      },
    ],
  };
  const first = validateProjectDefinitionValue(configuration);
  const second = validateProjectDefinitionValue(configuration);
  if (!first.ok || !second.ok) throw new Error("Expected the Schedule declaration to validate");
  expect(first.snapshot.workflows[0]?.schedules[0]?.revision).toBe(
    second.snapshot.workflows[0]?.schedules[0]?.revision,
  );

  const changed = validateProjectDefinitionValue({
    workflows: [
      { ...configuration.workflows[0], schedules: [{ ...schedule, cron: "30 9 * * 1-5" }] },
    ],
  });
  if (!changed.ok) throw new Error("Expected the changed Schedule declaration to validate");
  expect(changed.snapshot.workflows[0]?.schedules[0]?.revision).not.toBe(
    first.snapshot.workflows[0]?.schedules[0]?.revision,
  );
});

it("atomically rejects duplicate and malformed Workflow Schedules", () => {
  const schema = { ast: { _tag: "StringKeyword" } };
  const validation = validateProjectDefinitionValue({
    workflows: [
      {
        workflowKey: "first",
        revision: "one",
        inputSchema: schema,
        successSchema: schema,
        failureSchema: schema,
        handler: () => undefined,
        schedules: [
          {
            scheduleKey: "duplicate",
            workflowKey: "first",
            cron: "0 9 * * 1",
            timeZone: "UTC",
            input: { revision: "one", resolve: () => undefined },
          },
        ],
      },
      {
        workflowKey: "second",
        revision: "one",
        inputSchema: schema,
        successSchema: schema,
        failureSchema: schema,
        handler: () => undefined,
        schedules: [
          {
            scheduleKey: "duplicate",
            workflowKey: "second",
            cron: "0 9 * * 1",
            timeZone: "UTC",
            input: { revision: "one", resolve: () => undefined },
          },
        ],
      },
      {
        workflowKey: "third",
        revision: "one",
        inputSchema: schema,
        successSchema: schema,
        failureSchema: schema,
        handler: () => undefined,
        schedules: [
          {
            scheduleKey: "malformed",
            workflowKey: "missing",
            cron: "0 0 9 * * *",
            timeZone: "Not/A-Time-Zone",
            input: { revision: "", resolve: "not-a-function" },
          },
        ],
      },
    ],
  });
  expect(validation).toMatchObject({ ok: false });
  if (validation.ok) return;
  expect(validation.findings.map((finding) => finding.findingKey)).toEqual(
    expect.arrayContaining(["schedule.key-duplicate", "schedule.definition-invalid"]),
  );
});
