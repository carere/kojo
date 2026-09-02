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

test("bounds reconnect attempts, preserves the snapshot, and disables all mutations", async ({
  page,
}) => {
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();

  let attempts = 0;
  await page.route("**/api/v1/projects", async (route) => {
    attempts += 1;
    await route.abort("connectionrefused");
  });
  await expect(page.getByText("Reconnect to the Daemon", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  expect(attempts).toBe(3);
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();
  const mutationScope = page.locator("[data-daemon-mutation-scope]");
  await expect(mutationScope).toHaveAttribute("disabled", "");

  await page.unroute("**/api/v1/projects");
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByText("Reconnect to the Daemon", { exact: true })).toBeHidden();
  await expect(mutationScope).not.toHaveAttribute("disabled", "");
});
