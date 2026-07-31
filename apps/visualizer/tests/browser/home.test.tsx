import { ProjectIdentity, WorkflowRunId } from "@kojo/control";
import { Schema } from "effect";
import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { ColorModeProvider } from "../../src/contexts/preferences/services/color-mode";
import { HostOverview } from "../../src/contexts/workflow-execution/host/components/host-overview";
import { WorkflowRuns } from "../../src/contexts/workflow-execution/runs/components/workflow-runs";
import { setLocale } from "../../src/i18n/runtime";

let dispose: VoidFunction | undefined;
const emptyActivitySummary = {
  invocationAttempts: 0,
  incompleteAttempts: 0,
  retries: 0,
  durableCompletions: 0,
  replayReuses: 0,
};

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

test("shows the Kojo starting point", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview />
      </ColorModeProvider>
    ),
    root,
  );

  await expect
    .element(page.getByRole("heading", { name: "The new Kojo starts here." }))
    .toBeVisible();
});

test("switches to the dark color mode", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview />
      </ColorModeProvider>
    ),
    root,
  );

  await page.getByRole("button", { name: "Dark" }).click();

  await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.style.colorScheme).toBe("dark");
});

test("shows Host connectivity and the authoritative empty Project state", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() =>
            Promise.resolve({
              host: {
                protocol: { major: 1, minor: 1 },
                hostVersion: "0.1.0",
                capabilities: ["projects:list"],
              },
              projects: [],
              projectDefinitions: [],
              workflowSchedules: [],
              workflowOccurrences: [],
              workflowRuns: [],
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByText("Connected to Kojo Host 0.1.0")).toBeVisible();
  await expect.element(page.getByText("No Kojo Projects yet.")).toBeVisible();
});

test("shows accepted Workflow Definition snapshots from the Host", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000001",
  );
  const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000010");
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() =>
            Promise.resolve({
              host: {
                protocol: { major: 1, minor: 2 },
                hostVersion: "0.1.0",
                capabilities: ["projects:list", "workflows:list"],
              },
              projects: [{ identity, path: "/projects/demo" }],
              projectDefinitions: [
                {
                  project: { identity, path: "/projects/demo" },
                  definitions: {
                    snapshotId: "snapshot",
                    workflows: [
                      {
                        workflowKey: "echo",
                        revision: "1",
                        inputSchemaFingerprint: "input",
                        successSchemaFingerprint: "success",
                        failureSchemaFingerprint: "failure",
                        sourceIdentity: "source",
                        sensitivity: { input: ["token"], success: [], failure: [] },
                        childWorkflowKeys: [],
                        schedules: [],
                      },
                    ],
                  },
                },
              ],
              workflowSchedules: [],
              workflowOccurrences: [],
              workflowRuns: [
                {
                  project: { identity, path: "/projects/demo" },
                  runs: [
                    {
                      runId,
                      workflowKey: "echo",
                      workflowRevision: "1",
                      state: "completed",
                      acceptedAtMs: 1,
                      engineConfirmedAtMs: 1,
                      updatedAtMs: 2,
                      finalizedAtMs: 2,
                      allowedActions: [],
                      activitySummary: {
                        invocationAttempts: 1,
                        incompleteAttempts: 0,
                        retries: 0,
                        durableCompletions: 1,
                        replayReuses: 0,
                      },
                      sandboxTrace: [
                        {
                          artifactIds: ["artifact-1"],
                          durationMs: 2,
                          exitCode: 0,
                          kind: "command.completed",
                          operationKey: "command",
                          providerKind: "docker",
                          recordedAtMs: 2,
                          sandboxIdentity: "sandbox-1",
                        },
                      ],
                    },
                  ],
                },
              ],
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByText("Accepted Workflow Definitions")).toBeVisible();
  await expect.element(page.getByText("echo 1")).toBeVisible();
  await expect.element(page.getByText("00000000-0000-7000-8000-000000000010")).toBeVisible();
  await expect.element(page.getByText("completed")).toBeVisible();
  await expect.element(page.getByText("Sandbox: 1 trace entries")).toBeVisible();
});

test("only renders Host-authorized Workflow Run controls", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000001",
  );
  const automaticRun = Schema.decodeUnknownSync(WorkflowRunId)(
    "00000000-0000-7000-8000-000000000020",
  );
  const manualRun = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000021");
  const deferredRun = Schema.decodeUnknownSync(WorkflowRunId)(
    "00000000-0000-7000-8000-000000000022",
  );
  const resumed: Array<string> = [];
  const completed: Array<{ readonly runId: string; readonly token: string }> = [];
  dispose = render(
    () => (
      <WorkflowRuns
        snapshots={[
          {
            project: { identity, path: "/projects/demo" },
            runs: [
              {
                runId: automaticRun,
                workflowKey: "clock",
                workflowRevision: "1",
                state: "suspended",
                acceptedAtMs: 1,
                engineConfirmedAtMs: 1,
                updatedAtMs: 1,
                finalizedAtMs: null,
                allowedActions: [],
                activitySummary: emptyActivitySummary,
                sandboxTrace: [],
              },
              {
                runId: manualRun,
                workflowKey: "manual",
                workflowRevision: "1",
                state: "suspended",
                acceptedAtMs: 1,
                engineConfirmedAtMs: 1,
                updatedAtMs: 1,
                finalizedAtMs: null,
                allowedActions: ["resume"],
                activitySummary: emptyActivitySummary,
                sandboxTrace: [],
              },
              {
                runId: deferredRun,
                workflowKey: "deferred",
                workflowRevision: "1",
                state: "suspended",
                acceptedAtMs: 1,
                engineConfirmedAtMs: 1,
                updatedAtMs: 1,
                finalizedAtMs: null,
                allowedActions: ["deferred-complete"],
                activitySummary: emptyActivitySummary,
                sandboxTrace: [],
              },
            ],
          },
        ]}
        onResume={async (_identity, runId) => {
          resumed.push(runId);
        }}
        onCompleteDeferred={async (_identity, runId, token) => {
          completed.push({ runId, token });
        }}
      />
    ),
    root,
  );

  expect(document.querySelector(`[aria-label="Value for ${automaticRun}"]`)).toBeNull();
  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByLabelText(`Deferred token for ${deferredRun}`).fill("kojo.deferred.v1.token");
  await page.getByRole("button", { name: "Complete Deferred" }).click();

  expect(resumed).toEqual([manualRun]);
  expect(completed).toEqual([{ runId: deferredRun, token: "kojo.deferred.v1.token" }]);
});

test("navigates between a Schedule Occurrence and its linked resources", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000001",
  );
  const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000010");
  const scheduledAtMs = Date.parse("2026-08-01T07:00:00.000Z");
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() =>
            Promise.resolve({
              host: {
                protocol: { major: 1, minor: 5 },
                hostVersion: "0.1.0",
                capabilities: ["schedules:show", "occurrences:list", "runs:show"],
              },
              projects: [{ identity, path: "/projects/demo" }],
              projectDefinitions: [],
              workflowSchedules: [
                {
                  project: { identity, path: "/projects/demo" },
                  schedules: [
                    {
                      scheduleKey: "morning-report",
                      definition: {
                        scheduleKey: "morning-report",
                        workflowKey: "report",
                        revision: "schedule-v1",
                        cron: "0 9 * * *",
                        timeZone: "Europe/Paris",
                        overlapPolicy: "skip",
                        inputRuleRevision: "input-v1",
                      },
                      appliedRevision: "schedule-v1",
                      enabledIntent: true,
                      condition: "available",
                      conditionReasonCode: null,
                      highWaterMarkMs: null,
                      nextOccurrenceMs: scheduledAtMs,
                      rowVersion: 1,
                      allowedActions: ["disable"],
                    },
                  ],
                },
              ],
              workflowOccurrences: [
                {
                  project: { identity, path: "/projects/demo" },
                  occurrences: [
                    {
                      scheduleKey: "morning-report",
                      scheduledAtMs,
                      appliedRevision: "schedule-v1",
                      input: { kind: "report" },
                      inputSensitivityPaths: [],
                      outcome: "started",
                      reasonCode: null,
                      deliveryAttemptCount: 1,
                      plannedAtMs: scheduledAtMs - 10,
                      firstAttemptedAtMs: scheduledAtMs,
                      processedAtMs: scheduledAtMs,
                      linkedRunId: runId,
                      missedRange: null,
                    },
                  ],
                },
              ],
              workflowRuns: [
                {
                  project: { identity, path: "/projects/demo" },
                  runs: [
                    {
                      runId,
                      workflowKey: "report",
                      workflowRevision: "1",
                      state: "completed",
                      acceptedAtMs: scheduledAtMs,
                      engineConfirmedAtMs: scheduledAtMs,
                      updatedAtMs: scheduledAtMs,
                      finalizedAtMs: scheduledAtMs,
                      allowedActions: [],
                      activitySummary: emptyActivitySummary,
                      sandboxTrace: [],
                    },
                  ],
                },
              ],
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await page.getByRole("button", { name: "View Schedule" }).click();
  await expect
    .element(
      page.getByText(
        "Navigated to Schedule morning-report in Project 00000000-0000-7000-8000-000000000001",
      ),
    )
    .toBeVisible();

  await page.getByRole("button", { name: "View linked Run" }).click();
  await expect
    .element(
      page.getByText(
        "Navigated to Workflow Run 00000000-0000-7000-8000-000000000010 in Project 00000000-0000-7000-8000-000000000001",
      ),
    )
    .toBeVisible();
});
