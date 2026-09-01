import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const root = "/tmp/kojo-ticket-71-browser";
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
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47243/");
  await page.getByRole("link", { name: "project-missing" }).click();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await expect(page.locator("[data-workflow-id]")).toHaveCount(3);
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

  await page.getByLabel("Workflow availability").selectOption("invalid");
  await expect(page.locator("[data-workflow-id]")).toHaveCount(1);
  await expect(page).toHaveURL(/workflow=invalid/);
  await page.reload();
  await expect(page.getByLabel("Workflow availability")).toHaveValue("invalid");

  const navigation = page.getByRole("navigation", { name: "Console" });
  await expect(navigation.getByRole("link")).toHaveCount(4);
});
