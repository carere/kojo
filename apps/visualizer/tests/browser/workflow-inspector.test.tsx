import {
  type ExecutionTracePage,
  type HostOverview as HostOverviewSnapshot,
  ProjectIdentity,
  WorkflowRunId,
  type WorkflowRunSnapshot,
} from "@kojo/control";
import { Schema } from "effect";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { ColorModeProvider } from "../../src/contexts/preferences/services/color-mode";
import { HostOverviewError } from "../../src/contexts/shared/models/contracts";
import { WorkflowInspector } from "../../src/contexts/workflow-execution/workflow-inspector/components/workflow-inspector";
import { useWorkflowInspectorActions } from "../../src/contexts/workflow-execution/workflow-inspector/hooks/use-workflow-inspector-actions";
import type { DialogKind } from "../../src/contexts/workflow-execution/workflow-inspector/models/workflow-inspector-models";
import { setLocale } from "../../src/i18n/runtime";

let dispose: VoidFunction | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  window.localStorage.removeItem("kojo.navigator.preferences");
  document.body.replaceChildren();
});

const firstIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
  "00000000-0000-7000-8000-000000000101",
);
const secondIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
  "00000000-0000-7000-8000-000000000102",
);
const firstRunId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000111");
const childRunId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000112");
const secondRunId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000121");

const activitySummary = {
  invocationAttempts: 2,
  incompleteAttempts: 0,
  retries: 1,
  durableCompletions: 1,
  replayReuses: 1,
};

const run = (
  runId: WorkflowRunId,
  workflowKey: string,
  parentRunId: WorkflowRunId | null = null,
  allowedActions: ReadonlyArray<"resume" | "deferred-complete" | "stop"> = [],
) => ({
  runId,
  workflowKey,
  workflowRevision: "1",
  state: "suspended" as const,
  acceptedAtMs: 1,
  engineConfirmedAtMs: 2,
  updatedAtMs: 3,
  finalizedAtMs: null,
  parentRunId,
  childInvocationKey: parentRunId === null ? null : "deliver-child",
  allowedActions,
  activitySummary,
  agentTrace: [],
  sandboxTrace: [
    {
      artifactIds: ["artifact-first"],
      durationMs: 4,
      exitCode: 0,
      kind: "command.completed" as const,
      operationKey: "command",
      providerKind: "fixture",
      recordedAtMs: 3,
      sandboxIdentity: "sandbox",
    },
  ],
});

const firstProject = { identity: firstIdentity, path: "/projects/first-project" };
const secondProject = { identity: secondIdentity, path: "/projects/second-project" };

const overview: HostOverviewSnapshot = {
  host: {
    protocol: { major: 1, minor: 12 },
    hostVersion: "0.1.0",
    capabilities: [
      "projects:list",
      "workflows:list",
      "runs:start",
      "runs:reveal",
      "control:subscribe",
      "traces:read",
    ],
  },
  projects: [firstProject, secondProject],
  projectDefinitions: [
    {
      project: firstProject,
      definitions: {
        snapshotId: "first-snapshot",
        workflows: [
          {
            workflowKey: "first-workflow",
            revision: "1",
            inputSchemaFingerprint: "input",
            successSchemaFingerprint: "success",
            failureSchemaFingerprint: "failure",
            sourceIdentity: "first-source",
            sensitivity: { input: ["secret"], success: [], failure: [] },
            childWorkflowKeys: ["first-child"],
            schedules: [],
          },
        ],
      },
    },
    {
      project: secondProject,
      definitions: {
        snapshotId: "second-snapshot",
        workflows: [
          {
            workflowKey: "second-workflow",
            revision: "2",
            inputSchemaFingerprint: "input",
            successSchemaFingerprint: "success",
            failureSchemaFingerprint: "failure",
            sourceIdentity: "second-source",
            sensitivity: { input: [], success: [], failure: [] },
            childWorkflowKeys: [],
            schedules: [],
          },
        ],
      },
    },
  ],
  workflowSchedules: [
    {
      project: firstProject,
      schedules: [
        {
          scheduleKey: "first-schedule",
          definition: {
            scheduleKey: "first-schedule",
            workflowKey: "first-workflow",
            revision: "1",
            cron: "0 9 * * 1-5",
            timeZone: "Europe/Paris",
            overlapPolicy: "allow",
            inputRuleRevision: "1",
          },
          appliedRevision: "1",
          enabledIntent: true,
          condition: "available",
          conditionReasonCode: null,
          highWaterMarkMs: 1,
          nextOccurrenceMs: null,
          rowVersion: 1,
          allowedActions: ["disable"],
        },
      ],
    },
    { project: secondProject, schedules: [] },
  ],
  workflowOccurrences: [
    {
      project: firstProject,
      occurrences: [
        {
          scheduleKey: "first-schedule",
          scheduledAtMs: 1,
          appliedRevision: "1",
          input: { _tag: "sensitive-value-masked" },
          inputSensitivityPaths: ["secret"],
          outcome: "skipped",
          reasonCode: "schedule.missed-range",
          deliveryAttemptCount: 0,
          plannedAtMs: 1,
          firstAttemptedAtMs: null,
          processedAtMs: 2,
          linkedRunId: null,
          missedRange: { count: 3, firstScheduledAtMs: 1, lastScheduledAtMs: 3 },
        },
      ],
    },
    { project: secondProject, occurrences: [] },
  ],
  workflowRuns: [
    {
      project: firstProject,
      runs: [
        run(firstRunId, "first-workflow", null, ["resume", "stop"]),
        run(childRunId, "first-child", firstRunId),
      ],
    },
    { project: secondProject, runs: [run(secondRunId, "second-workflow")] },
  ],
  retention: [
    {
      project: firstProject,
      policy: {
        diagnosticMaxAgeMs: 86_400_000,
        diagnosticMaxBytes: 1_024,
        disposableMaxAgeMs: 172_800_000,
        disposableMaxBytes: 2_048,
      },
      usage: {
        diagnosticBytes: 100,
        disposableBytes: 200,
        protectedDisposableBytes: 100,
        eligibleDisposableBytes: 100,
        availableArtifactCount: 1,
        missingArtifactCount: 1,
        expiredArtifactCount: 1,
        lastCleanupAtMs: 3,
      },
      warnings: [
        {
          code: "missing-retained-content",
          kind: "disposable",
          message:
            "Some retained Artifact content is missing, but its authoritative metadata remains.",
          next: "Inspect the Artifact trace evidence.",
          observedAtMs: 3,
          currentBytes: 1,
          limitBytes: null,
        },
      ],
      hostDiagnosticMaxAgeMs: 86_400_000,
      hostDiagnosticMaxBytes: 4_096,
      observedAtMs: 3,
    },
    {
      project: secondProject,
      policy: {
        diagnosticMaxAgeMs: null,
        diagnosticMaxBytes: null,
        disposableMaxAgeMs: null,
        disposableMaxBytes: null,
      },
      usage: {
        diagnosticBytes: 0,
        disposableBytes: 0,
        protectedDisposableBytes: 0,
        eligibleDisposableBytes: 0,
        availableArtifactCount: 0,
        missingArtifactCount: 0,
        expiredArtifactCount: 0,
        lastCleanupAtMs: null,
      },
      warnings: [],
      hostDiagnosticMaxAgeMs: 86_400_000,
      hostDiagnosticMaxBytes: 4_096,
      observedAtMs: 3,
    },
  ],
};

const traceFor = (
  runId: WorkflowRunId,
  kind: "run.accepted" | "activity.attempt-started",
): ExecutionTracePage => {
  const kinds =
    kind === "run.accepted"
      ? ["run.accepted", "activity.attempt-started", "artifact.unavailable", "run.suspended"]
      : ["activity.attempt-started"];
  const events = kinds.map((eventKind, index) => ({
    eventId: `${runId}-${eventKind}`,
    runId,
    sequence: index + 1,
    envelopeVersion: 1,
    kind: eventKind,
    kindVersion: 1,
    recordedAtMs: index + 1,
    observedAtMs: null,
    engineOperationId: null,
    activityAttemptId: null,
    boundaryId: null,
    childRunId: null,
    compatibility: "supported" as const,
    payload: {},
  }));
  return {
    events,
    firstSequence: 1,
    hasMore: false,
    lastSequence: events.length,
    nextCursor: null,
    highWaterSequence: events.length,
    runState: "suspended",
    final: false,
  };
};

test("retries a transient initial Host overview without a page reload", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  let attempts = 0;
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <WorkflowInspector
          loadOverview={(signal) =>
            new Promise<HostOverviewSnapshot | undefined>((resolve, reject) => {
              attempts += 1;
              if (attempts === 1) {
                signal.addEventListener(
                  "abort",
                  () => reject(new Error("Transient HostOverview request interrupted.")),
                  { once: true },
                );
                return;
              }
              resolve(overview);
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByText("Connected to Kojo Host 0.1.0")).toBeVisible();
  expect(attempts).toBe(2);
});

test("discovers a Project registered after an authoritative empty index without reload", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  let attempts = 0;
  const emptyOverview: HostOverviewSnapshot = {
    ...overview,
    projects: [],
    projectDefinitions: [],
    workflowSchedules: [],
    workflowOccurrences: [],
    workflowRuns: [],
    retention: [],
  };
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <WorkflowInspector
          loadOverview={async () => {
            attempts += 1;
            return attempts === 1 ? emptyOverview : overview;
          }}
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByText("No Kojo Projects yet.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "first-project" })).toBeVisible();
  expect(attempts).toBe(2);
});

test("shows a recoverable HostOverview error after finite exhaustion and succeeds on Retry", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  let attempts = 0;
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <WorkflowInspector
          loadOverview={(_signal) => {
            attempts += 1;
            if (attempts <= 4) {
              return Promise.reject(
                new HostOverviewError({
                  code: "host-unavailable",
                  message: "Host is still starting.",
                  next: "Retry the Host request.",
                }),
              );
            }
            return Promise.resolve(overview);
          }}
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(document.body.textContent?.includes("Connecting to Kojo Host…")).toBe(false);
  await page.getByRole("button", { name: "Retry HostOverview", exact: true }).click();
  await expect.element(page.getByText("Connected to Kojo Host 0.1.0")).toBeVisible();
  expect(attempts).toBe(5);
});

test("discards a delayed sensitive reveal after switching Project and Run identity", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  let resolveReveal:
    | ((result: { readonly ok: true; readonly run: WorkflowRunSnapshot }) => void)
    | undefined;
  const first = run(firstRunId, "first-workflow");
  const second = run(secondRunId, "second-workflow");

  const RevealHarness = () => {
    const [identity, setIdentity] = createSignal(firstIdentity);
    const [selectedRunId, setSelectedRunId] = createSignal<WorkflowRunId | undefined>(firstRunId);
    const [revealedRun, setRevealedRun] = createSignal<WorkflowRunSnapshot>();
    const [_dialog, setDialog] = createSignal<DialogKind>("reveal");
    const runId = () => selectedRunId() ?? firstRunId;
    const actions = useWorkflowInspectorActions({
      identity,
      run: () => (runId() === firstRunId ? first : second),
      definition: () => undefined,
      production: true,
      reloadOverview: async () => undefined,
      setDialog,
      setSelectedRunId,
      setRevealedRun,
      revealWorkflowRun: async (receivedIdentity, receivedRunId) => {
        expect(receivedIdentity).toBe(firstIdentity);
        expect(receivedRunId).toBe(firstRunId);
        return await new Promise((resolve) => {
          resolveReveal = resolve;
        });
      },
    });

    return (
      <div>
        <button type="button" onClick={() => void actions.reveal()}>
          Start delayed reveal
        </button>
        <button
          type="button"
          onClick={() => {
            setIdentity(secondIdentity);
            setSelectedRunId(secondRunId);
          }}
        >
          Switch Project and Run
        </button>
        <output data-reveal-selection>
          {identity()}:{runId()}
        </output>
        <output data-revealed-run>{revealedRun()?.runId ?? "none"}</output>
      </div>
    );
  };

  dispose = render(() => <RevealHarness />, root);
  await page.getByRole("button", { name: "Start delayed reveal" }).click();
  await expect.poll(() => resolveReveal !== undefined).toBe(true);
  await page.getByRole("button", { name: "Switch Project and Run" }).click();
  await expect
    .poll(() => document.querySelector("[data-reveal-selection]")?.textContent)
    .toBe(`${secondIdentity}:${secondRunId}`);

  resolveReveal?.({ ok: true, run: { runId: firstRunId } as WorkflowRunSnapshot });
  await expect.poll(() => document.querySelector("[data-revealed-run]")?.textContent).toBe("none");
});

test("renders the production inspector with isolated Projects, evidence, controls, retention, and accessible panels", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <WorkflowInspector
          loadOverview={() => Promise.resolve(overview)}
          loadTrace={(selection) =>
            Promise.resolve(
              traceFor(
                selection.runId,
                selection.identity === firstIdentity ? "run.accepted" : "activity.attempt-started",
              ),
            )
          }
          traceRefreshIntervalMs={60_000}
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.element(page.getByText("Connected to Kojo Host 0.1.0")).toBeVisible();
  await expect
    .element(
      page.getByRole("heading", { name: "Structural ownership and execution relationships" }),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Numbered live Event feed" }))
    .toBeVisible();
  await expect.element(page.getByText("Child Workflow Run · deliver-child")).toBeVisible();
  await expect.element(page.getByText("Workflow Run suspended")).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Workflow Schedules" }).getByText("first-schedule"))
    .toBeVisible();
  await expect.element(page.getByText("3 missed instant(s) retained as evidence")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Download Artifact artifact-first" }))
    .toBeVisible();

  const inspector = page.getByRole("complementary", { name: "Run inspection panel" });
  await expect.element(inspector.getByText("Masked by default.")).toBeVisible();
  await expect
    .element(inspector.getByRole("button", { name: "Resume Workflow Run" }))
    .toBeVisible();
  await expect.element(inspector.getByRole("button", { name: "Request safe stop" })).toBeVisible();
  await expect
    .element(inspector.getByRole("button", { name: "Start a fresh Workflow Run" }))
    .toBeVisible();
  expect(
    document.querySelectorAll(
      '[aria-label="Deferred token for 00000000-0000-7000-8000-000000000111"]',
    ).length,
  ).toBe(0);
  expect(
    Array.from(document.querySelectorAll("button")).filter((button) =>
      /delete/i.test(button.textContent ?? ""),
    ).length,
  ).toBe(0);

  await inspector.getByRole("button", { name: "Review warning & reveal" }).click();
  await expect
    .element(page.getByRole("heading", { name: "Reveal Sensitive Execution Data?" }))
    .toBeVisible();
  await expect
    .element(page.getByText("Revealing payloads does not reveal Artifact bytes"))
    .toBeVisible();
  await page.getByRole("button", { name: "Keep masked" }).click();

  const navigatorResizerElement = document.querySelector(
    '[aria-label="Resize Project resource navigator"]',
  );
  const inspectorResizerElement = document.querySelector(
    '[aria-label="Resize Run inspection panel"]',
  );
  if (
    !(navigatorResizerElement instanceof HTMLElement) ||
    !(inspectorResizerElement instanceof HTMLElement)
  )
    throw new Error("Panel resizers are missing.");
  navigatorResizerElement.focus();
  navigatorResizerElement.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  expect(navigatorResizerElement.getAttribute("aria-valuenow")).toBe("420");
  navigatorResizerElement.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
  );
  expect(navigatorResizerElement.getAttribute("aria-valuenow")).toBe("220");
  inspectorResizerElement.focus();
  inspectorResizerElement.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  expect(inspectorResizerElement.getAttribute("aria-valuenow")).toBe("420");
  await page.getByRole("button", { name: "Collapse Project resource navigator" }).click();
  await expect
    .element(
      page.getByRole("heading", { name: "Structural ownership and execution relationships" }),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Expand Project resource navigator" }).click();

  const projects = page.getByRole("navigation", { name: "Kojo Projects" });
  await projects.getByRole("button", { name: "second-project" }).click();
  const resources = page.getByRole("complementary", { name: "Project resource navigator" });
  await expect.element(resources.getByText("second-workflow 2")).toBeVisible();
  expect(
    document.querySelector('[aria-label="Project resource navigator"]')?.textContent,
  ).not.toContain("first-workflow 1");
  await expect.element(page.getByRole("button", { name: secondRunId, exact: true })).toBeVisible();
  expect(document.querySelectorAll(`[aria-label="${firstRunId}"]`).length).toBe(0);
  expect(document.querySelectorAll(`[aria-label="${childRunId}"]`).length).toBe(0);
  expect(
    JSON.parse(window.localStorage.getItem("kojo.navigator.preferences") ?? "null"),
  ).toMatchObject({
    selectedProjectIdentity: secondIdentity,
  });
});
