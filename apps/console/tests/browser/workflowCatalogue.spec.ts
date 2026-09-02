import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

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

test("shows separate Workflow state in a Project-scoped Zaidan grid", async ({ page }) => {
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
});
