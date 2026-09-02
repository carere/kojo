import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const root = "/tmp/kojo-ticket-71-browser";
// A two-core CI host can render this catalogue while another Daemon fixture uses the other worker.
// Keep its first-render bound below the 60-second test bound; later assertions keep Playwright's default.
const catalogueNavigationTimeout = 30_000;
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launch = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the Workflow fixture Daemon did not issue a grant");
  return result.stdout;
};

test("paginates the complete Workflow table and keeps its cursor in the URL", async ({ page }) => {
  await page.route("**/api/v1/projects/*/workflows", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as {
      workflows: ReadonlyArray<Record<string, unknown>>;
    };
    const template = snapshot.workflows[0];
    if (template === undefined) throw new Error("the Workflow fixture has no pagination template");
    const workflows = Array.from({ length: 51 }, (_, index) => ({
      ...template,
      workflowName: `workflow-page-${String(index + 1).padStart(2, "0")}`,
    }));
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({ ...snapshot, workflows }),
    });
  });
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47243/");
  await page.getByRole("link", { name: "project-missing" }).click();
  await expect(page.locator("[data-workflow-id]")).toHaveCount(50, {
    timeout: catalogueNavigationTimeout,
  });
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator("[data-workflow-id]")).toHaveCount(1);
  await expect(page).toHaveURL(/cursor=50/);
});

test("filters Workflow state and proves safe Trigger Start, Stop, force, and Run links", async ({
  page,
}) => {
  await page.route("**/actions/stop", async (route) => {
    const body = route.request().postDataJSON() as { readonly force?: boolean };
    if (body.force !== true) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "stop",
        projectId: "project-missing",
        workflowName: "available",
        activity: "inactive",
        admittedRunsContinue: false,
        forced: true,
        targetSetId: "target-browser",
        targetedRunIds: ["run-current"],
      }),
    });
  });
  await page.goto(launch());
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await page.goto("http://127.0.0.1:47243/");
  await page.getByRole("link", { name: "project-missing" }).click();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({
    timeout: catalogueNavigationTimeout,
  });
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
  await page.getByRole("button", { name: "Stop" }).first().click();
  await expect(page.getByRole("status")).toContainText("Admitted Runs remain eligible");
  const forced = page.getByRole("button", { name: "Stop with force" }).first();
  await expect(forced).toBeDisabled();
  await page
    .getByText("I understand that forced Stop records cancellation", { exact: false })
    .first()
    .click();
  await forced.click();
  await expect(page.getByRole("status")).toContainText(
    "Cancellation intent is separate from confirmed stop",
  );
  await page.getByRole("button", { name: "Start Trigger" }).first().click();
  await expect(page.getByRole("status")).toContainText(
    "Trigger listening. No immediate Run was created.",
  );
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
  await page.route("**/api/v1/projects/*/workflows", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as {
      readonly workflows: ReadonlyArray<Record<string, unknown>>;
    };
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({
        ...snapshot,
        workflows: snapshot.workflows.map((workflow) =>
          workflow.workflowName === "available"
            ? {
                ...workflow,
                activity: "inactive",
                currentRuns: [],
                trigger: { state: "not-declared" },
              }
            : workflow,
        ),
      }),
    });
  });
  await page.route("**/api/v1/projects/*/workflows/available/actions/start", async (route) => {
    starts += 1;
    expect(route.request().postDataJSON()).toMatchObject({ payload: { release: 7 } });
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "run",
        runId: "run-browser-start",
        revisionId: "a".repeat(64),
        duplicate: false,
      }),
    });
  });
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47243/");
  await page.getByRole("link", { name: "project-missing" }).click();
  const row = page.locator("[data-workflow-id]").filter({ hasText: "available" }).first();
  const payload = row.getByLabel("JSON payload for available");
  await payload.fill("{");
  await row.getByRole("button", { name: "Start Run" }).click();
  await expect(row.getByRole("status")).toBeVisible();
  expect(starts).toBe(0);
  await payload.fill('{"release":7}');
  await row.getByRole("button", { name: "Start Run" }).click();
  await expect(row.getByRole("status")).toContainText("run-browser-start");
  expect(starts).toBe(1);
});
