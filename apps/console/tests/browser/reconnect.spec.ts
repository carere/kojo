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
  let releaseAuthoritativeRead: (() => void) | undefined;
  let authoritativeReadStarted = false;
  await page.route("**/api/v1/projects", async (route) => {
    authoritativeReadStarted = true;
    await new Promise<void>((resolve) => {
      releaseAuthoritativeRead = resolve;
    });
    await route.continue();
  });
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => authoritativeReadStarted).toBe(true);
  await expect(mutationScope).toHaveAttribute("disabled", "");
  releaseAuthoritativeRead?.();
  await expect(page.getByText("Reconnect to the Daemon", { exact: true })).toBeHidden();
  await expect(mutationScope).not.toHaveAttribute("disabled", "");
});

test("bounds stalled notification connection attempts before explicit Reconnect", async ({
  page,
}) => {
  await page.goto(launch());
  let attempts = 0;
  await page.route("**/api/v1/notifications", async (route) => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await route.continue();
  });

  const startedAt = Date.now();
  await page.goto("http://127.0.0.1:47242/");
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();
  await expect(page.getByText("Reconnect to the Daemon", { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  expect(attempts).toBe(3);
  expect(Date.now() - startedAt).toBeLessThan(20_000);
  await expect(page.locator("[data-daemon-mutation-scope]")).toHaveAttribute("disabled", "");
  await expect(page.getByText("2 total", { exact: true })).toBeVisible();
});
