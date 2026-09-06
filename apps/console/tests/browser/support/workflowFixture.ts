import type { ProjectSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type {
  RunDocument,
  RunSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/run";
import type {
  WorkflowDocument,
  WorkflowSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import type { Page } from "@playwright/test";

const observedAt = "2026-09-01T00:00:00.000Z";
const revisionId = "a".repeat(64);
const observation = {
  observationVersion: 1 as const,
  instanceId: "browser-fixture",
  dataIdentity: "browser-fixture",
  snapshotVersion: 1,
  observedAt,
  refreshAfterMillis: 1_000,
};

// Each test owns its observations. UI actions cannot wake a real Runner or change another test.
export const workflowFixture = async (page: Page) => {
  const available: WorkflowDocument = {
    projectId: "project-missing",
    projectLabel: "project-missing",
    projectState: "available",
    factoryState: "available",
    refreshState: "current",
    workflowName: "available",
    activity: "active",
    availability: "available",
    source: "/fixture/.kojo/workflows/available.ts",
    currentRevisionId: revisionId,
    trigger: { state: "polling", detail: "Trigger position 42" },
    currentRuns: [{ runId: "run-queued", state: "queued", queueReason: "runner-starting" }],
    refreshedAt: observedAt,
  };
  const state: { workflows: WorkflowDocument[] } = {
    workflows: [
      available,
      {
        ...available,
        workflowName: "invalid",
        activity: "inactive",
        availability: "invalid",
        sourceFault: "declares another name",
        remedy: "Make the declared name match the file name.",
        trigger: { state: "not-declared" },
        currentRuns: [],
      },
      {
        ...available,
        workflowName: "faulted",
        trigger: {
          state: "failed",
          detail: "five transient acknowledgement retries were exhausted",
        },
        currentRuns: [],
      },
      {
        ...available,
        workflowName: "removed",
        activity: "inactive",
        availability: "removed",
        trigger: { state: "not-declared" },
        currentRuns: [],
      },
    ],
  };
  const selected: RunDocument = {
    runId: "run-queued",
    projectId: available.projectId,
    workflowName: "available",
    revisionId,
    packageGraphId: "b".repeat(64),
    state: "queued",
    queueReason: "runner-starting",
    admittedAt: observedAt,
    phases: [],
  };
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({
      json: {
        ...observation,
        counts: {
          total: 1,
          available: 1,
          unavailable: 0,
          archived: 0,
          missingFactories: 0,
          invalidFactories: 0,
        },
        projects: [
          {
            projectId: available.projectId,
            label: available.projectLabel,
            location: "/fixture",
            locationActive: true,
            locationConfirmed: true,
            projectState: "available",
            factoryState: "available",
            refreshState: "current",
            registeredAt: observedAt,
            refreshedAt: observedAt,
            locationChange: { state: "steady" },
            locationHistory: [],
          },
        ],
      } satisfies ProjectSnapshot,
    }),
  );
  await page.route("**/api/v1/projects/*/workflows", (route) =>
    route.fulfill({
      json: {
        ...observation,
        counts: {
          total: state.workflows.length,
          available: state.workflows.filter((workflow) => workflow.availability === "available")
            .length,
          invalid: state.workflows.filter((workflow) => workflow.availability === "invalid").length,
          removed: state.workflows.filter((workflow) => workflow.availability === "removed").length,
          active: state.workflows.filter((workflow) => workflow.activity === "active").length,
        },
        workflows: state.workflows,
      } satisfies WorkflowSnapshot,
    }),
  );
  await page.route("**/api/v1/runs", (route) =>
    route.fulfill({
      json: {
        ...observation,
        runs: [
          selected,
          { ...selected, runId: "run-unrelated-workflow", workflowName: "invalid" },
          { ...selected, runId: "run-unrelated-project", projectId: "project-other" },
        ],
      } satisfies RunSnapshot,
    }),
  );
  await page.route("**/api/v1/client-requests/*", (route) =>
    route.fulfill({ status: 202, json: {} }),
  );
  // A missing action fixture must fail at the request, without mutating the shared Daemon.
  await page.route("**/api/v1/projects/*/workflows/*/actions/*", (route) =>
    route.fulfill({
      status: 501,
      json: { detail: "This test has no fixture for the Workflow action." },
    }),
  );
  return { state, available };
};
