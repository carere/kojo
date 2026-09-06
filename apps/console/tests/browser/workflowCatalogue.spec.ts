import { spawnSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { openAuthenticatedConsole } from "./support/openAuthenticatedConsole.ts";
import { workflowFixture } from "./support/workflowFixture.ts";

const root = "/tmp/kojo-ticket-69-browser";
const origin = "http://127.0.0.1:47241";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launch = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the Workflow fixture Daemon did not issue a grant");
  return result.stdout;
};

const openWorkflows = async (page: Page) => {
  await openAuthenticatedConsole(page, launch());
  await page.goto(origin);
  await page.getByRole("link", { name: "project-missing" }).click();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
};

test("paginates the complete Workflow table and keeps its cursor in the URL", async ({ page }) => {
  const { state, available } = await workflowFixture(page);
  state.workflows = Array.from({ length: 51 }, (_, index) => ({
    ...available,
    workflowName: `workflow-page-${String(index + 1).padStart(2, "0")}`,
  }));
  await openWorkflows(page);
  await expect(page.locator("[data-workflow-id]")).toHaveCount(50);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator("[data-workflow-id]")).toHaveCount(1);
  await expect(page).toHaveURL(/cursor=50/);
});

test("filters Workflow state and preserves current Run links", async ({ page }) => {
  await workflowFixture(page);
  await openWorkflows(page);
  await expect(page.locator("[data-workflow-id]")).toHaveCount(4);
  for (const heading of [
    "Project",
    "Factory",
    "Refresh",
    "Activity",
    "Availability",
    "Source",
    "Revision",
    "Trigger observation",
  ]) {
    await expect(page.getByRole("columnheader", { name: heading })).toBeVisible();
  }
  await expect(page.getByText("declares another name", { exact: true })).toBeVisible();
  await expect(page.getByText("polling", { exact: true })).toBeVisible();
  await expect(page.getByText("failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Actions and current Runs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Current Runs (1)" }).first()).toHaveAttribute(
    "href",
    /\/runs\?project=.*workflow=available/,
  );

  await page.getByLabel("Workflow availability").selectOption("invalid");
  await expect(page.locator("[data-workflow-id]")).toHaveCount(1);
  await expect(page).toHaveURL(/workflow=invalid/);
  await page.reload();
  await expect(page.getByLabel("Workflow availability")).toHaveValue("invalid");

  const navigation = page.getByRole("navigation", { name: "Console" });
  await expect(navigation.getByRole("link")).toHaveCount(4);

  await page.getByLabel("Workflow availability").selectOption("all");
  await page.getByRole("link", { name: "Current Runs (1)" }).click();
  await expect(page.getByRole("columnheader", { name: "Queue reason" })).toBeVisible();
  await expect(page).toHaveURL(/\/runs\?project=.*workflow=available/);
  await expect(page.locator("[data-run]")).toHaveCount(1);
  await expect(page.locator('[data-run="run-queued"]')).toBeVisible();
  await expect(page.locator('[data-run="run-unrelated-workflow"]')).toHaveCount(0);
  await expect(page.locator('[data-run="run-unrelated-project"]')).toHaveCount(0);
  await expect(page.getByText("runner-starting", { exact: true })).toBeVisible();
  await page.getByLabel("Find Runs").fill("runner-starting");
  await page.getByLabel("Run status").selectOption("queued");
  await expect(page.locator("[data-run]")).toHaveCount(1);
  await expect(page).toHaveURL(/q=runner-starting.*status=queued/);
});

test("validates JSON before a no-Trigger Start and submits one accepted Run payload", async ({
  page,
}) => {
  let starts = 0;
  const { state, available } = await workflowFixture(page);
  state.workflows = [
    { ...available, activity: "inactive", currentRuns: [], trigger: { state: "not-declared" } },
  ];
  await page.route("**/api/v1/projects/*/workflows/available/actions/start", async (route) => {
    starts += 1;
    const body = route.request().postDataJSON() as {
      readonly target: { readonly parts: ReadonlyArray<string> };
    };
    const projectId = new URL(route.request().url()).pathname.split("/")[4];
    expect(body).toMatchObject({
      operation: "startWorkflow",
      target: { kind: "workflow", parts: [projectId, "available"] },
      arguments: { payload: { release: 7 } },
      preconditions: { mode: "no-trigger", revisionId: expect.any(String) },
    });
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "run",
        runId: "run-browser-start",
        revisionId: "a".repeat(64),
        duplicate: false,
        state: "queued",
      }),
    });
  });
  await openWorkflows(page);
  const row = page.locator("[data-workflow-id]").first();
  const payload = row.getByLabel("JSON payload for available");
  await expect(payload).toHaveValue("{}");
  await payload.fill("{");
  await expect(payload).toHaveValue("{");
  await row.getByRole("button", { name: "Start Run" }).click();
  await expect(row.getByRole("status")).toBeVisible();
  expect(starts).toBe(0);
  await payload.fill('{"release":7}');
  await row.getByRole("button", { name: "Start Run" }).click();
  await expect(row.getByRole("status")).toContainText("run-browser-start");
  expect(starts).toBe(1);
});

for (const force of [false, true]) {
  test(
    force
      ? "requires acknowledgement before forced Workflow Stop"
      : "explains that ordinary Workflow Stop keeps admitted Runs eligible",
    async ({ page }) => {
      const { state, available } = await workflowFixture(page);
      state.workflows = [available];
      let stops = 0;
      await page.route("**/workflows/available/actions/stop", async (route) => {
        stops += 1;
        expect(route.request().method()).toBe("POST");
        expect(route.request().postDataJSON().arguments).toEqual(force ? { force: true } : {});
        expect(route.request().postDataJSON()).toMatchObject({
          operation: "stopWorkflow",
          target: { kind: "workflow", parts: ["project-missing", "available"] },
          arguments: force ? { force: true } : {},
          preconditions: {},
        });
        state.workflows = [{ ...available, activity: "inactive" }];
        await route.fulfill({
          status: 202,
          json: {
            kind: "stop",
            projectId: "project-missing",
            workflowName: "available",
            activity: "inactive",
            admittedRunsContinue: !force,
            forced: force,
            ...(force ? { targetSetId: "target-browser", targetedRunIds: ["run-queued"] } : {}),
          },
        });
      });
      await openWorkflows(page);
      const button = page.getByRole("button", {
        name: force ? "Stop with force" : "Stop",
        exact: true,
      });
      if (force) {
        await expect(button).toBeDisabled();
        expect(stops).toBe(0);
        await page.getByRole("checkbox").check();
      }
      await button.click();
      await expect(page.getByRole("status")).toContainText(
        force
          ? "Cancellation intent is separate from confirmed stop"
          : "Admitted Runs remain eligible",
      );
      expect(stops).toBe(1);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
    },
  );
}

test("starts a Trigger without creating an immediate Run", async ({ page }) => {
  const { state, available } = await workflowFixture(page);
  state.workflows = [{ ...available, activity: "inactive", currentRuns: [] }];
  let starts = 0;
  await page.route("**/workflows/available/actions/start", async (route) => {
    starts += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      operation: "startWorkflow",
      target: { kind: "workflow", parts: ["project-missing", "available"] },
      arguments: {},
      preconditions: { mode: "trigger", revisionId: available.currentRevisionId },
    });
    state.workflows = [{ ...available, currentRuns: [] }];
    await route.fulfill({
      status: 202,
      json: {
        kind: "trigger",
        projectId: "project-missing",
        workflowName: "available",
        activity: "active",
        triggerState: "polling",
        pollerStarted: true,
      },
    });
  });
  await openWorkflows(page);
  await page.getByRole("button", { name: "Start Trigger" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Trigger listening. No immediate Run was created.",
  );
  expect(starts).toBe(1);
  await expect(page.getByRole("link", { name: "Current Runs (0)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
});
