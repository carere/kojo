import {
  type ExecutionTracePage,
  type HostOverview as HostOverviewSnapshot,
  ProjectIdentity,
  WorkflowRunId,
} from "@kojo/control";
import { Effect, Schema, Stream } from "effect";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { ColorModeProvider } from "../../src/contexts/preferences/services/color-mode";
import { HostOverview } from "../../src/contexts/workflow-execution/host/components/host-overview";
import { WorkflowRuns } from "../../src/contexts/workflow-execution/runs/components/workflow-runs";
import { ExecutionTrace } from "../../src/contexts/workflow-execution/traces/components/execution-trace";
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

test("shows read-only retention policy, usage, and warnings", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000001",
  );
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() =>
            Promise.resolve({
              host: {
                protocol: { major: 1, minor: 13 },
                hostVersion: "0.1.0",
                capabilities: ["projects:list", "retention:show"],
              },
              projects: [{ identity, path: "/projects/demo" }],
              retention: [
                {
                  project: { identity, path: "/projects/demo" },
                  policy: {
                    diagnosticMaxAgeMs: 14,
                    diagnosticMaxBytes: 100,
                    disposableMaxAgeMs: 30,
                    disposableMaxBytes: 1,
                  },
                  usage: {
                    diagnosticBytes: 10,
                    disposableBytes: 20,
                    protectedDisposableBytes: 12,
                    eligibleDisposableBytes: 8,
                    availableArtifactCount: 1,
                    missingArtifactCount: 2,
                    expiredArtifactCount: 3,
                    lastCleanupAtMs: 1,
                  },
                  warnings: [
                    {
                      code: "protected-over-limit",
                      kind: "disposable",
                      message:
                        "Protected non-final execution content exceeds the disposable retention limit.",
                      next: "Keep the content protected.",
                      observedAtMs: 1,
                      currentBytes: 12,
                      limitBytes: 1,
                    },
                    {
                      code: "missing-retained-content",
                      kind: "disposable",
                      message:
                        "Some retained Artifact content is missing, but its authoritative metadata remains.",
                      next: "Inspect the Artifact trace evidence.",
                      observedAtMs: 1,
                      currentBytes: 2,
                      limitBytes: null,
                    },
                  ],
                  hostDiagnosticMaxAgeMs: 14,
                  hostDiagnosticMaxBytes: 500,
                  observedAtMs: 1,
                },
              ],
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

  await expect
    .element(page.getByRole("region", { name: "Execution data retention" }))
    .toBeVisible();
  const retention = document.querySelector('[aria-label="Execution data retention"]');
  expect(retention).not.toBeNull();
  expect(retention?.textContent).toContain("Protected non-final execution content exceeds");
  expect(retention?.textContent).toContain("Some retained Artifact content is missing");
  expect(retention?.textContent).toContain("Destructive retention controls remain CLI-only.");
  expect(retention?.querySelectorAll("button")).toHaveLength(0);
  expect(document.body.textContent).not.toMatch(
    /delete (execution|run|occurrence|schedule|project)/i,
  );
  expect(
    document.querySelectorAll('[aria-label*="delete" i], [data-action*="delete" i]'),
  ).toHaveLength(0);
});

test("renders Host-produced readiness guidance without exposing hidden diagnostic details", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000001",
  );
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() =>
            Promise.resolve({
              host: {
                protocol: { major: 1, minor: 8 },
                hostVersion: "0.1.0",
                capabilities: ["projects:list", "readiness:show", "readiness:refresh"],
              },
              projects: [{ identity, path: "/projects/demo" }],
              readiness: [
                {
                  project: { identity, path: "/projects/demo" },
                  revision: "readiness-revision",
                  assessedAtMs: 1,
                  condition: "needs-attention",
                  capabilities: [
                    {
                      capability: "project:inspect",
                      available: true,
                      findingKeys: [],
                    },
                    {
                      capability: "history:inspect",
                      available: true,
                      findingKeys: [],
                    },
                    {
                      capability: "runs:control",
                      available: true,
                      findingKeys: [],
                    },
                    {
                      capability: "runs:recover",
                      available: false,
                      findingKeys: ["layout.ignore-rule-missing"],
                    },
                    {
                      capability: "runs:start",
                      available: false,
                      findingKeys: ["layout.ignore-rule-missing"],
                    },
                    {
                      capability: "schedules:process",
                      available: false,
                      findingKeys: ["layout.ignore-rule-missing"],
                    },
                    {
                      capability: "repair:safe",
                      available: true,
                      findingKeys: [],
                    },
                  ],
                  findings: [
                    {
                      key: "layout.ignore-rule-missing:demo",
                      code: "layout.ignore-rule-missing",
                      affectedResource: { kind: "layout", path: "/projects/demo" },
                      blockedCapabilities: ["runs:recover", "runs:start", "schedules:process"],
                      dependents: [],
                      summary: "The Project-local /.kojo/ ignore rule is missing.",
                      relevant: ["internal-diagnostic-token"],
                      repairClass: "explicit",
                      actions: [
                        {
                          key: "layout.add-ignore-rule",
                          label: "Add the /.kojo/ ignore rule",
                        },
                      ],
                      firstObservedAtMs: 1,
                      lastObservedAtMs: 1,
                    },
                  ],
                  repairs: [],
                },
              ],
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

  await expect
    .element(page.getByRole("heading", { name: "Project Runtime Readiness" }))
    .toBeVisible();
  await expect.element(page.getByText("layout.ignore-rule-missing")).toBeVisible();
  await expect
    .element(page.getByText("The Project-local /.kojo/ ignore rule is missing."))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Add the /.kojo/ ignore rule" }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("internal-diagnostic-token");
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
                      parentRunId: null,
                      childInvocationKey: null,
                      allowedActions: [],
                      activitySummary: {
                        invocationAttempts: 1,
                        incompleteAttempts: 0,
                        retries: 0,
                        durableCompletions: 1,
                        replayReuses: 0,
                      },
                      agentTrace: [
                        {
                          artifactIds: ["artifact-2"],
                          durationMs: 3,
                          kind: "agent.started",
                          operationKey: "agent",
                          providerKind: "codex",
                          recordedAtMs: 2,
                          sandboxIdentity: "sandbox-1",
                        },
                        {
                          artifactIds: [],
                          durationMs: null,
                          kind: "agent.replayed",
                          operationKey: "agent",
                          providerKind: "codex",
                          recordedAtMs: 3,
                          sandboxIdentity: "sandbox-1",
                        },
                        {
                          artifactIds: [],
                          durationMs: null,
                          kind: "agent.session-continued",
                          operationKey: "agent",
                          providerKind: "codex",
                          recordedAtMs: 4,
                          sandboxIdentity: "sandbox-1",
                        },
                      ],
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
  await expect
    .element(
      page.getByText("Agents: 1 attempts, 1 Activity replays, 1 provider-session continuations"),
    )
    .toBeVisible();
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
  const stoppableRun = Schema.decodeUnknownSync(WorkflowRunId)(
    "00000000-0000-7000-8000-000000000023",
  );
  const resumed: Array<string> = [];
  const completed: Array<{ readonly runId: string; readonly token: string }> = [];
  const stopped: Array<string> = [];
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
                parentRunId: null,
                childInvocationKey: null,
                allowedActions: [],
                activitySummary: emptyActivitySummary,
                agentTrace: [],
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
                parentRunId: null,
                childInvocationKey: null,
                allowedActions: ["resume"],
                activitySummary: emptyActivitySummary,
                agentTrace: [],
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
                parentRunId: null,
                childInvocationKey: null,
                allowedActions: ["deferred-complete"],
                activitySummary: emptyActivitySummary,
                agentTrace: [],
                sandboxTrace: [],
              },
              {
                runId: stoppableRun,
                workflowKey: "stoppable",
                workflowRevision: "1",
                state: "running",
                acceptedAtMs: 1,
                engineConfirmedAtMs: 1,
                updatedAtMs: 1,
                finalizedAtMs: null,
                parentRunId: null,
                childInvocationKey: null,
                allowedActions: ["stop"],
                activitySummary: emptyActivitySummary,
                agentTrace: [],
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
        onStop={async (_identity, runId) => {
          stopped.push(runId);
        }}
      />
    ),
    root,
  );

  expect(document.querySelector(`[aria-label="Value for ${automaticRun}"]`)).toBeNull();
  window.dispatchEvent(new Event("pagehide"));
  expect(stopped).toEqual([]);
  await page.getByRole("button", { name: "Resume Workflow Run" }).click();
  await page.getByLabelText(`Deferred token for ${deferredRun}`).fill("kojo.deferred.v1.token");
  await page.getByRole("button", { name: "Complete Deferred" }).click();
  await page.getByRole("button", { name: "Stop Workflow Run" }).click();

  expect(resumed).toEqual([manualRun]);
  expect(completed).toEqual([{ runId: deferredRun, token: "kojo.deferred.v1.token" }]);
  expect(stopped).toEqual([stoppableRun]);
});

test("renders Child Workflow Runs beneath their parent with the relationship edge", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000001",
  );
  const parentRun = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000030");
  const childRun = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000031");
  dispose = render(
    () => (
      <WorkflowRuns
        snapshots={[
          {
            project: { identity, path: "/projects/demo" },
            runs: [
              {
                runId: parentRun,
                workflowKey: "parent",
                workflowRevision: "1",
                state: "running",
                acceptedAtMs: 1,
                engineConfirmedAtMs: 1,
                updatedAtMs: 1,
                finalizedAtMs: null,
                parentRunId: null,
                childInvocationKey: null,
                allowedActions: [],
                activitySummary: emptyActivitySummary,
                agentTrace: [],
                sandboxTrace: [],
              },
              {
                runId: childRun,
                workflowKey: "child",
                workflowRevision: "1",
                state: "running",
                acceptedAtMs: 2,
                engineConfirmedAtMs: 2,
                updatedAtMs: 2,
                finalizedAtMs: null,
                parentRunId: parentRun,
                childInvocationKey: "send-child",
                allowedActions: [],
                activitySummary: emptyActivitySummary,
                agentTrace: [],
                sandboxTrace: [],
              },
            ],
          },
        ]}
        onResume={async () => undefined}
        onCompleteDeferred={async () => undefined}
      />
    ),
    root,
  );

  await expect.element(page.getByText(`← ${parentRun} (send-child)`)).toBeVisible();
  const rows = Array.from(document.querySelectorAll("[data-run-id]"));
  expect(rows.map((row) => row.getAttribute("data-run-id"))).toEqual([parentRun, childRun]);
  const childRow = document.querySelector(`[data-run-id="${childRun}"]`);
  expect(childRow?.getAttribute("data-parent-run-id")).toBe(parentRun);
  expect(childRow?.classList.contains("border-l-2")).toBe(true);
});

test("renders live chronological Execution Trace evidence separately from the Workflow Run tree", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000001",
  );
  const parentRun = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000040");
  const childRun = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000041");
  const overview = {
    host: {
      protocol: { major: 1, minor: 8 },
      hostVersion: "0.1.0",
      capabilities: ["runs:list", "traces:read"],
    },
    projects: [{ identity, path: "/projects/demo" }],
    projectDefinitions: [],
    workflowSchedules: [],
    workflowOccurrences: [],
    workflowRuns: [
      {
        project: { identity, path: "/projects/demo" },
        runs: [
          {
            runId: parentRun,
            workflowKey: "parent",
            workflowRevision: "1",
            state: "running",
            acceptedAtMs: 1,
            engineConfirmedAtMs: 1,
            updatedAtMs: 1,
            finalizedAtMs: null,
            parentRunId: null,
            childInvocationKey: null,
            allowedActions: [],
            activitySummary: emptyActivitySummary,
            agentTrace: [],
            sandboxTrace: [],
          },
          {
            runId: childRun,
            workflowKey: "child",
            workflowRevision: "1",
            state: "running",
            acceptedAtMs: 2,
            engineConfirmedAtMs: 2,
            updatedAtMs: 2,
            finalizedAtMs: null,
            parentRunId: parentRun,
            childInvocationKey: "deliver-child",
            allowedActions: [],
            activitySummary: emptyActivitySummary,
            agentTrace: [],
            sandboxTrace: [],
          },
        ],
      },
    ],
  } satisfies HostOverviewSnapshot;
  const firstPage: ExecutionTracePage = {
    events: [
      {
        eventId: "event-one",
        runId: parentRun,
        sequence: 1,
        envelopeVersion: 1,
        kind: "run.accepted",
        kindVersion: 1,
        recordedAtMs: 1,
        observedAtMs: null,
        engineOperationId: null,
        activityAttemptId: null,
        boundaryId: null,
        childRunId: null,
        compatibility: "supported",
        payload: {},
      },
    ],
    firstSequence: 1,
    hasMore: false,
    lastSequence: 1,
    nextCursor: null,
    highWaterSequence: 1,
    runState: "running",
    final: false,
  };
  const liveEvent = {
    eventId: "event-two",
    runId: parentRun,
    sequence: 2,
    envelopeVersion: 1,
    kind: "child.requested" as const,
    kindVersion: 1,
    recordedAtMs: 2,
    observedAtMs: null,
    engineOperationId: null,
    activityAttemptId: null,
    boundaryId: null,
    childRunId: childRun,
    compatibility: "supported" as const,
    payload: { artifactIds: ["artifact-one"] },
  };
  let traceReads = 0;
  const acknowledged: Array<{
    readonly deliverySequence: number;
    readonly subscriptionId: string;
  }> = [];
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <HostOverview
          loadOverview={() => Promise.resolve(overview)}
          loadTrace={() => Promise.resolve(traceReads++ === 0 ? firstPage : undefined)}
          acknowledgeTrace={(delivery) =>
            Effect.sync(() => {
              acknowledged.push({
                deliverySequence: delivery.deliverySequence,
                subscriptionId: delivery.subscriptionId,
              });
            })
          }
          followTrace={(selection, afterSequence) => {
            expect(selection).toEqual({ identity, runId: parentRun });
            expect(afterSequence).toBe(1);
            return Stream.concat(
              Stream.make({
                kind: "trace-event",
                deliverySequence: 1,
                identity,
                runId: parentRun,
                sequence: 2,
                subscriptionId: "browser-subscription" as never,
                event: liveEvent,
              }),
              Stream.never,
            );
          }}
        />
      </ColorModeProvider>
    ),
    root,
  );

  await page.getByRole("button", { name: parentRun }).click();
  await expect.element(page.getByRole("heading", { name: "Execution Trace" })).toBeVisible();
  await expect
    .element(
      page.getByText(
        "The Workflow Run tree above shows ownership and child relationships; it is not this Event order.",
      ),
    )
    .toBeVisible();
  expect(
    document.querySelector(`[data-run-id="${childRun}"]`)?.getAttribute("data-parent-run-id"),
  ).toBe(parentRun);
  await expect.poll(() => document.querySelectorAll("[data-event-sequence]").length).toBe(2);
  expect(traceReads).toBe(1);
  expect(
    Array.from(document.querySelectorAll("[data-event-sequence]")).map((event) =>
      event.getAttribute("data-event-sequence"),
    ),
  ).toEqual(["1", "2"]);
  await expect.element(page.getByText("child.requested@1")).toBeVisible();
  const artifactDownload = page.getByRole("link", { name: "Download Artifact artifact-one" });
  await expect.element(artifactDownload).toBeVisible();
  await expect(artifactDownload).toHaveAttribute(
    "href",
    `/api/artifacts?artifact=artifact-one&project=${identity}&run=${parentRun}`,
  );
  await expect
    .poll(() => acknowledged)
    .toEqual([{ deliverySequence: 1, subscriptionId: "browser-subscription" }]);
});

test("reloads durable trace state and reconnects after live transport loss", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000025",
  );
  const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000026");
  const firstPage: ExecutionTracePage = {
    events: [],
    final: false,
    firstSequence: null,
    hasMore: false,
    highWaterSequence: 1,
    lastSequence: 1,
    nextCursor: null,
    runState: "running",
  };
  const reconnectedEvent = {
    eventId: "reconnected-event",
    runId,
    sequence: 2,
    envelopeVersion: 1,
    kind: "run.completed",
    kindVersion: 1,
    recordedAtMs: 2,
    observedAtMs: null,
    engineOperationId: null,
    activityAttemptId: null,
    boundaryId: null,
    childRunId: null,
    compatibility: "supported" as const,
    payload: {},
  };
  const reloadedPage: ExecutionTracePage = {
    ...firstPage,
    events: [reconnectedEvent],
    firstSequence: 2,
    highWaterSequence: 2,
    lastSequence: 2,
  };
  let loads = 0;
  let follows = 0;
  const acknowledged: Array<number> = [];
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <ExecutionTrace
          selection={{ identity, runId }}
          loadTrace={() => Promise.resolve(loads++ === 0 ? firstPage : reloadedPage)}
          followTrace={() => {
            follows += 1;
            return follows === 1
              ? Stream.fail(new Error("socket lost"))
              : Stream.concat(
                  Stream.make({
                    deliverySequence: 1,
                    kind: "trace-event" as const,
                    identity,
                    runId,
                    sequence: 2,
                    subscriptionId: "reconnected" as never,
                    event: reconnectedEvent,
                  }),
                  Stream.never,
                );
          }}
          acknowledgeTrace={(delivery) =>
            Effect.sync(() => {
              acknowledged.push(delivery.deliverySequence);
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.poll(() => follows).toBe(2);
  await expect.poll(() => loads).toBe(2);
  await expect.element(page.getByText("run.completed@1")).toBeVisible();
  await expect.element(page.getByText("completed · sequence 2 · final")).toBeVisible();
  expect(acknowledged).toEqual([1]);
});

test("clears old trace history before a delayed Project switch completes", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const firstIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000031",
  );
  const secondIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000032",
  );
  const firstRunId = Schema.decodeUnknownSync(WorkflowRunId)(
    "00000000-0000-7000-8000-000000000033",
  );
  const secondRunId = Schema.decodeUnknownSync(WorkflowRunId)(
    "00000000-0000-7000-8000-000000000034",
  );
  const tracePage = (_identity: ProjectIdentity, runId: WorkflowRunId, eventId: string) =>
    ({
      events: [
        {
          eventId,
          runId,
          sequence: 1,
          envelopeVersion: 1,
          kind: "run.accepted",
          kindVersion: 1,
          recordedAtMs: 1,
          observedAtMs: null,
          engineOperationId: null,
          activityAttemptId: null,
          boundaryId: null,
          childRunId: null,
          compatibility: "supported" as const,
          payload: {},
        },
      ],
      firstSequence: 1,
      hasMore: false,
      lastSequence: 1,
      nextCursor: null,
      highWaterSequence: 1,
      runState: "running" as const,
      final: false,
    }) satisfies ExecutionTracePage;
  let resolveSecond: ((page: ExecutionTracePage) => void) | undefined;
  const firstPage = tracePage(firstIdentity, firstRunId, "first-event");
  const secondPage = tracePage(secondIdentity, secondRunId, "second-event");
  const [selection, setSelection] = createSignal<{
    readonly identity: ProjectIdentity;
    readonly runId: WorkflowRunId;
  }>({ identity: firstIdentity, runId: firstRunId });
  dispose = render(
    () => (
      <div>
        <button
          type="button"
          onClick={() => setSelection({ identity: secondIdentity, runId: secondRunId })}
        >
          Switch trace Project
        </button>
        <ExecutionTrace
          selection={selection()}
          loadTrace={(current) =>
            current.identity === firstIdentity
              ? Promise.resolve(firstPage)
              : new Promise((resolve) => {
                  resolveSecond = resolve;
                })
          }
        />
      </div>
    ),
    root,
  );

  await expect.element(page.getByText("run.accepted@1")).toBeVisible();
  await page.getByRole("button", { name: "Switch trace Project" }).click();
  await expect.poll(() => document.querySelector("[data-event-sequence]")).toBeNull();
  resolveSecond?.(secondPage);
  await expect.poll(() => document.querySelector(`[data-run-id="${secondRunId}"]`)).not.toBeNull();
  expect(document.querySelector(`[data-run-id="${firstRunId}"]`)).toBeNull();
});

test("recovers the initial trace after one Host read fails without a reload", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000035",
  );
  const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000036");
  const tracePage: ExecutionTracePage = {
    events: [
      {
        eventId: "initial-recovery-event",
        runId,
        sequence: 1,
        envelopeVersion: 1,
        kind: "run.accepted",
        kindVersion: 1,
        recordedAtMs: 1,
        observedAtMs: null,
        engineOperationId: null,
        activityAttemptId: null,
        boundaryId: null,
        childRunId: null,
        compatibility: "supported",
        payload: {},
      },
    ],
    firstSequence: 1,
    hasMore: false,
    lastSequence: 1,
    nextCursor: null,
    highWaterSequence: 1,
    runState: "running",
    final: false,
  };
  let loads = 0;
  dispose = render(
    () => (
      <ExecutionTrace
        selection={{ identity, runId }}
        refreshIntervalMs={60_000}
        loadTrace={() => {
          loads += 1;
          return loads === 1
            ? Promise.reject(new Error("Host trace request was briefly unavailable."))
            : Promise.resolve(tracePage);
        }}
      />
    ),
    root,
  );

  await expect.element(page.getByText("run.accepted@1")).toBeVisible();
  expect(loads).toBe(2);
  expect(page.getByRole("alert").length).toBe(0);
});

test("acknowledges a trace resync only after its authoritative reload succeeds", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000021",
  );
  const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000022");
  const page: ExecutionTracePage = {
    events: [],
    final: false,
    firstSequence: null,
    hasMore: false,
    highWaterSequence: 0,
    lastSequence: null,
    nextCursor: null,
    runState: "running",
  };
  let loads = 0;
  let resolveReload: ((value: ExecutionTracePage | undefined) => void) | undefined;
  let follows = 0;
  const acknowledgements: Array<number> = [];
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <ExecutionTrace
          selection={{ identity, runId }}
          loadTrace={() => {
            loads += 1;
            if (loads === 1) return Promise.resolve(page);
            return new Promise((resolve) => {
              resolveReload = resolve;
            });
          }}
          followTrace={() => {
            follows += 1;
            return follows === 1
              ? Stream.make({
                  deliverySequence: 1,
                  kind: "resync-required" as const,
                  highWaterSequence: 4,
                  identity,
                  runId,
                  subscriptionId: "resync-success" as never,
                })
              : Stream.never;
          }}
          acknowledgeTrace={(delivery) =>
            Effect.sync(() => {
              acknowledgements.push(delivery.deliverySequence);
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.poll(() => loads).toBe(2);
  expect(acknowledgements).toEqual([]);
  resolveReload?.(page);
  await expect.poll(() => acknowledgements).toEqual([1]);
  await expect.poll(() => follows).toBe(2);
});

test("does not acknowledge a trace resync whose authoritative reload fails", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000023",
  );
  const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000024");
  const page: ExecutionTracePage = {
    events: [],
    final: false,
    firstSequence: null,
    hasMore: false,
    highWaterSequence: 0,
    lastSequence: null,
    nextCursor: null,
    runState: "running",
  };
  let loads = 0;
  let follows = 0;
  const acknowledgements: Array<number> = [];
  dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <ExecutionTrace
          selection={{ identity, runId }}
          loadTrace={() => {
            loads += 1;
            return loads === 1 ? Promise.resolve(page) : Promise.reject(new Error("reload failed"));
          }}
          followTrace={() => {
            follows += 1;
            return follows === 1
              ? Stream.make({
                  deliverySequence: 1,
                  kind: "resync-required" as const,
                  highWaterSequence: 4,
                  identity,
                  runId,
                  subscriptionId: "resync-failure" as never,
                })
              : Stream.never;
          }}
          acknowledgeTrace={(delivery) =>
            Effect.sync(() => {
              acknowledgements.push(delivery.deliverySequence);
            })
          }
        />
      </ColorModeProvider>
    ),
    root,
  );

  await expect.poll(() => loads).toBe(3);
  await expect.poll(() => follows).toBe(2);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(acknowledgements).toEqual([]);
});

test("reconnects after clean trace stream completion until the component is cleaned up", async () => {
  setLocale("en", { reload: false });
  const root = document.createElement("div");
  document.body.append(root);
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(
    "00000000-0000-7000-8000-000000000027",
  );
  const runId = Schema.decodeUnknownSync(WorkflowRunId)("00000000-0000-7000-8000-000000000028");
  const tracePage: ExecutionTracePage = {
    events: [],
    final: false,
    firstSequence: null,
    hasMore: false,
    highWaterSequence: 0,
    lastSequence: null,
    nextCursor: null,
    runState: "running",
  };
  let loads = 0;
  let follows = 0;
  dispose = render(
    () => (
      <ExecutionTrace
        selection={{ identity, runId }}
        loadTrace={() => {
          loads += 1;
          return Promise.resolve(tracePage);
        }}
        followTrace={() => {
          follows += 1;
          return follows === 1 ? Stream.empty : Stream.never;
        }}
      />
    ),
    root,
  );

  await expect.poll(() => follows).toBe(2);
  expect(loads).toBe(2);
  expect(document.querySelectorAll("[data-event-sequence]")).toHaveLength(0);
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
                protocol: { major: 1, minor: 6 },
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
                      parentRunId: null,
                      childInvocationKey: null,
                      allowedActions: [],
                      activitySummary: emptyActivitySummary,
                      agentTrace: [],
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
