import { expect, type Page, test } from "@playwright/test";

const roots = {
  schemaVersion: 1,
  runs: [
    {
      attempt: 2,
      createdAt: "2026-07-21T10:42:03.000Z",
      project: {
        availability: { reason: "Registered folder is missing", status: "Unavailable" },
        displayName: "checkout",
        id: "project-checkout-1f9",
        registrationState: "Enabled",
      },
      runId: "run-failed-001",
      state: "Failed",
      workflowName: "delivery",
    },
    {
      attempt: 1,
      createdAt: "2026-07-21T09:00:00.000Z",
      project: {
        availability: { status: "Available" },
        displayName: "kojo",
        id: "project-kojo-7a2",
        registrationState: "Enabled",
      },
      runId: "run-completed-002",
      state: "Completed",
      workflowName: "delivery",
    },
  ],
};

const archivedRoot = {
  attempt: 1,
  createdAt: "2026-07-20T08:00:00.000Z",
  project: {
    availability: { reason: "Registered folder is missing", status: "Unavailable" },
    displayName: "legacy",
    id: "project-legacy-3c1",
    registrationState: "Archived",
  },
  runId: "run-archived-003",
  state: "Discarded",
  workflowName: "delivery",
};

const failedRun = {
  actions: [
    { enabled: false, name: "resume", reason: "Project source is unavailable" },
    { enabled: true, name: "discard" },
  ],
  attempts: [
    {
      finishedAt: "2026-07-21T10:43:00.000Z",
      number: 1,
      startedAt: "2026-07-21T10:42:03.000Z",
      state: "Interrupted",
    },
    {
      finishedAt: "2026-07-21T10:56:51.000Z",
      number: 2,
      startedAt: "2026-07-21T10:45:00.000Z",
      state: "Failed",
    },
  ],
  children: [
    {
      actions: [],
      attempts: [{ number: 1, startedAt: "2026-07-21T10:48:00.000Z", state: "Completed" }],
      children: [],
      createdAt: "2026-07-21T10:48:00.000Z",
      evidence: [
        {
          artifacts: [],
          attempt: 1,
          details: { input: { ticket: 40 }, invocationKey: "ticket-40" },
          eventId: "event-child-started",
          recordedAt: "2026-07-21T10:48:00.000Z",
          schema: { status: "Known", version: 1 },
          sequence: 1,
          subject: "implement-ticket",
          type: "WorkflowRun.Started",
        },
        {
          artifacts: [],
          attempt: 1,
          details: { value: { commit: "abc1234" } },
          eventId: "event-child-completed",
          parentEventId: "event-child-started",
          recordedAt: "2026-07-21T10:51:00.000Z",
          schema: { status: "Known", version: 1 },
          sequence: 2,
          subject: "implement-ticket",
          type: "WorkflowRun.Completed",
        },
      ],
      input: { ticket: 40 },
      invocationKey: "ticket-40",
      outcome: { commit: "abc1234" },
      parentRunId: "run-failed-001",
      projectId: "project-checkout-1f9",
      resumeCompatibility: { status: "NotApplicable" },
      rootRunId: "run-failed-001",
      runId: "run-child-040",
      runtimeConfigurationCompatibility: { status: "NotChecked" },
      state: "Completed",
      workflowName: "implement-ticket",
    },
  ],
  createdAt: "2026-07-21T10:42:03.000Z",
  evidence: [
    {
      artifacts: [],
      attempt: 1,
      details: { input: { workstream: 26 } },
      eventId: "event-root-started",
      recordedAt: "2026-07-21T10:42:03.000Z",
      schema: { status: "Known", version: 1 },
      sequence: 1,
      subject: "delivery",
      type: "WorkflowRun.Started",
    },
    {
      artifacts: [
        {
          availability: "Available",
          byteLength: 812,
          fingerprint: "sha256:review-report",
          mediaType: "application/json",
          name: "review-report",
        },
        {
          availability: "Unavailable",
          byteLength: 0,
          fingerprint: "sha256:missing-provider-output",
          mediaType: "application/json",
          name: "provider-output",
        },
      ],
      attempt: 2,
      details: { findings: [{ severity: "P2", title: "Lease fence is missing" }] },
      eventId: "event-review",
      parentEventId: "event-root-started",
      recordedAt: "2026-07-21T10:52:00.000Z",
      schema: { status: "Known", version: 1 },
      sequence: 2,
      subject: "review-ticket",
      type: "Review.FindingsRecorded",
    },
    {
      artifacts: [],
      attempt: 2,
      details: {
        encodingVersion: 99,
        futureEnvelopeField: { retained: true },
        value: { futureField: true },
      },
      eventId: "event-unknown",
      parentEventId: "event-root-started",
      recordedAt: "2026-07-21T10:55:00.000Z",
      schema: { status: "Unknown", version: 99 },
      sequence: 3,
      subject: "provider-call",
      type: "Provider.FutureEvidence",
    },
    {
      artifacts: [],
      attempt: 2,
      details: { _tag: "ReviewLimitReached" },
      eventId: "event-root-failed",
      parentEventId: "event-root-started",
      recordedAt: "2026-07-21T10:56:51.000Z",
      schema: { status: "Known", version: 1 },
      sequence: 4,
      subject: "delivery",
      type: "WorkflowRun.Failed",
    },
  ],
  input: { workstream: 26 },
  outcome: { _tag: "ReviewLimitReached" },
  projectId: "project-checkout-1f9",
  project: roots.runs[0]?.project,
  resumeCompatibility: { reason: "Project source is unavailable", status: "Unavailable" },
  rootRunId: "run-failed-001",
  runId: "run-failed-001",
  runtimeConfigurationCompatibility: { status: "NotChecked" },
  state: "Failed",
  workflowName: "delivery",
};

const installControlledApi = async (page: Page) => {
  await page.route("**/api/inspector/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/inspector/runs") {
      return route.fulfill({
        json: {
          ...roots,
          runs:
            url.searchParams.get("includeArchived") === "true"
              ? [...roots.runs, archivedRoot]
              : roots.runs,
        },
      });
    }
    if (path === "/api/inspector/runs/run-failed-001") {
      return route.fulfill({ json: { run: failedRun, schemaVersion: 1 } });
    }
    if (path === "/api/inspector/runs/run-completed-002") {
      return route.fulfill({
        json: {
          run: {
            ...failedRun,
            actions: [],
            children: [],
            evidence: [failedRun.evidence[0]],
            project: roots.runs[1]?.project,
            projectId: "project-kojo-7a2",
            resumeCompatibility: { status: "NotApplicable" },
            runId: "run-completed-002",
            rootRunId: "run-completed-002",
            state: "Completed",
          },
          schemaVersion: 1,
        },
      });
    }
    if (path === "/api/inspector/runs/run-archived-003") {
      return route.fulfill({
        json: {
          run: {
            ...failedRun,
            actions: [],
            children: [],
            evidence: [failedRun.evidence[0]],
            project: archivedRoot.project,
            projectId: "project-legacy-3c1",
            resumeCompatibility: { status: "NotApplicable" },
            runId: "run-archived-003",
            rootRunId: "run-archived-003",
            state: "Discarded",
          },
          schemaVersion: 1,
        },
      });
    }
    return route.fulfill({ json: { error: "Not found" }, status: 404 });
  });
};

test.beforeEach(async ({ page }) => {
  await installControlledApi(page);
  await page.goto("/");
});

test("selects root runs and preserves run-level facts", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Dense Inspector" })).toBeVisible();
  await expect(page.getByTestId("run-state")).toHaveText("Failed");
  await expect(page.getByTestId("resume-compatibility")).toContainText("Unavailable");
  await expect(page.getByRole("button", { name: "Resume" })).toBeDisabled();
  await expect(page.getByText("Project source is unavailable", { exact: true })).toBeVisible();
  await expect(page.getByTestId("project-registration-state")).toHaveText("Enabled");
  await expect(page.getByTestId("project-availability")).toHaveText("Unavailable");
  await expect(page.getByTestId("action-disabled-reason")).toHaveText(
    "Resume: Project source is unavailable",
  );

  await page.getByRole("button", { name: /run-completed-002/ }).click();
  await expect(page.getByTestId("run-state")).toHaveText("Completed");
  await expect(page.getByText("event-root-started")).toBeVisible();
});

test("navigates chronological evidence, artifacts, and unknown schemas", async ({ page }) => {
  await page.getByRole("button", { name: /Review.FindingsRecorded/ }).click();
  await expect(page.getByRole("heading", { name: "Review.FindingsRecorded" })).toBeVisible();
  await expect(page.getByText("Lease fence is missing")).toBeVisible();
  await expect(page.getByText("review-report", { exact: true })).toBeVisible();
  await expect(page.getByText("provider-output", { exact: true })).toBeVisible();
  await expect(page.locator(".artifact").filter({ hasText: "provider-output" })).toContainText(
    "Unavailable",
  );

  await page.getByRole("button", { name: /Provider.FutureEvidence/ }).click();
  await expect(page.getByText("Unknown schema v99")).toBeVisible();
  await expect(page.getByText('"futureField": true')).toBeVisible();
  await expect(page.getByText('"retained": true')).toBeVisible();
  await expect(page.getByTestId("run-state")).toHaveText("Failed");
});

test("navigates child runs and failure history without Project source", async ({ page }) => {
  await expect(page.locator(".project-availability-reason")).toHaveText(
    "Registered folder is missing",
  );
  await page.getByTestId("run-tree-run-child-040").click();
  await expect(page.getByTestId("selected-subject")).toContainText("run-child-040");
  await expect(page.getByRole("button", { name: /WorkflowRun.Completed/ })).toBeVisible();

  await page.getByTestId("run-tree-run-failed-001").click();
  await expect(page.getByText("Attempt 1 · Interrupted")).toBeVisible();
  await expect(page.getByText("Attempt 2 · Failed")).toBeVisible();
});

test("composes facets, disambiguates workflows, and pins investigations", async ({ page }) => {
  await expect(page.getByRole("combobox", { name: "Workflow" }).locator("option")).toHaveText([
    "All workflows",
    "delivery",
  ]);
  await expect(
    page.locator(".run-list .run-row").filter({ hasText: "run-failed-001" }),
  ).toContainText("checkout · project…t-1f9");
  await expect(
    page.locator(".run-list .run-row").filter({ hasText: "run-completed-002" }),
  ).toContainText("kojo · project…o-7a2");

  await page.getByRole("combobox", { name: "Workflow" }).selectOption("delivery");
  await expect(
    page.locator(".run-list .run-row").filter({ hasText: "run-failed-001" }),
  ).toBeVisible();
  await expect(
    page.locator(".run-list .run-row").filter({ hasText: "run-completed-002" }),
  ).toBeVisible();
  await expect(page.getByText("PINNED OUTSIDE FILTERS")).toHaveCount(0);

  await page.getByRole("combobox", { name: "Project" }).selectOption("project-kojo-7a2");
  await expect(page.getByText("PINNED OUTSIDE FILTERS")).toBeVisible();
  await expect(
    page.locator(".run-list .run-row").filter({ hasText: "run-completed-002" }),
  ).toBeVisible();
  await expect(page.getByTestId("selected-subject")).toContainText("run-failed-001");

  await page.getByRole("combobox", { name: "State" }).selectOption("Failed");
  await expect(page.getByText("No runs match these filters.")).toBeVisible();
  await expect(page.getByText("PINNED OUTSIDE FILTERS")).toBeVisible();
  await expect(page.getByTestId("selected-subject")).toContainText("run-failed-001");
});

test("retains a selected child trace subject when facets change", async ({ page }) => {
  await page.getByTestId("run-tree-run-child-040").click();
  await page.getByRole("button", { name: /WorkflowRun.Completed/ }).click();
  await expect(page.getByTestId("selected-subject")).toContainText("run-child-040");
  await expect(page.getByRole("heading", { name: "WorkflowRun.Completed" })).toBeVisible();

  await page.getByRole("combobox", { name: "Project" }).selectOption("project-kojo-7a2");
  await expect(page.getByText("PINNED OUTSIDE FILTERS")).toBeVisible();
  await expect(page.getByTestId("selected-subject")).toContainText("run-child-040");
  await expect(page.getByRole("heading", { name: "WorkflowRun.Completed" })).toBeVisible();
});

test("keeps Archived history behind explicit opt-in", async ({ page }) => {
  await expect(page.getByRole("button", { name: /run-archived-003/ })).toHaveCount(0);
  await page.getByLabel("Archived history").check();
  await expect(page.getByRole("button", { name: /run-archived-003/ })).toBeVisible();
});

test("can opt into Archived history when no active Project has runs", async ({ page }) => {
  await expect(page.getByTestId("run-state")).toHaveText("Failed");
  await page.unroute("**/api/inspector/**");
  await page.route("**/api/inspector/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/inspector/runs") {
      return route.fulfill({
        json: {
          schemaVersion: 1,
          runs: url.searchParams.get("includeArchived") === "true" ? [archivedRoot] : [],
        },
      });
    }
    if (url.pathname === "/api/inspector/runs/run-archived-003") {
      return route.fulfill({
        json: {
          run: {
            ...failedRun,
            actions: [],
            children: [],
            evidence: [failedRun.evidence[0]],
            project: archivedRoot.project,
            projectId: "project-legacy-3c1",
            resumeCompatibility: { status: "NotApplicable" },
            rootRunId: "run-archived-003",
            runId: "run-archived-003",
            state: "Discarded",
          },
          schemaVersion: 1,
        },
      });
    }
    return route.fulfill({ json: { error: "Not found" }, status: 404 });
  });

  await page.reload();
  await expect(page.getByText("No runs match these filters.")).toBeVisible();
  await page.getByLabel("Archived history").check();
  await expect(page.locator(".run-row").filter({ hasText: "run-archived-003" })).toBeVisible();
  await expect(page.getByTestId("run-state")).toHaveText("Discarded");
});
