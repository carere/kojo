import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const root = "/tmp/kojo-ticket-70-browser";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launch = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the Project fixture Daemon did not issue a grant");
  return result.stdout;
};

test("filters an authoritative Project grid and keeps stable URL selection", async ({ page }) => {
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();
  await expect(page.locator("[data-project-id]")).toHaveCount(2);
  await expect(page.getByText("1 missing Factory", { exact: true })).toBeVisible();
  await expect(page.getByText("1 invalid Factory", { exact: true })).toBeVisible();

  await page.getByLabel("Factory state").selectOption("missing");
  await expect(page.locator("[data-project-id]")).toHaveCount(1);
  await page.getByLabel("Find Projects").fill("does-not-exist");
  await expect(page.getByText("No Projects match these filters.", { exact: true })).toBeVisible();
  await page.getByLabel("Find Projects").fill("");

  const selector = page.getByRole("checkbox", { name: /Select project-missing/ });
  await selector.check();
  await expect(page).toHaveURL(/factory=missing.*selected=/);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /Select project-missing/ })).toBeChecked();

  const navigation = page.getByRole("navigation", { name: "Console" });
  await expect(navigation.getByRole("link")).toHaveCount(4);
  await expect(navigation.getByText("project-missing")).toHaveCount(0);
});
