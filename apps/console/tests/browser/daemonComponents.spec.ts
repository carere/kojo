import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const root = "/tmp/kojo-ticket-70-browser";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launch = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the component fixture Daemon did not issue a grant");
  return result.stdout;
};

test("keeps Zaidan composition keyboard-operable on narrow layouts and exposes documented custom gaps", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");

  await expect(page.locator('[data-list-composition="zaidan-data-grid"]')).toBeVisible();
  await expect(page.locator('[data-slot="filters"]')).toBeVisible();
  await page.getByLabel("Find Projects").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Project state")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Factory state")).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.getByRole("link", { name: "Runs" }).click();
  await expect(page.locator('[data-list-composition="custom-status-table"]')).toBeVisible();
  await expect(page.locator('[data-slot="filters"]')).toBeVisible();

  await page.getByRole("link", { name: "Gate" }).click();
  await expect(page.locator('[data-list-composition="custom-grouped-table"]')).toBeVisible();
  await expect(page.locator('[data-slot="filters"]')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
