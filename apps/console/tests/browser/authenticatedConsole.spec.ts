import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const testRoot = "/tmp/kojo-ticket-69-browser";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launchUrl = (): string => {
  const result = spawnSync("bun", [grantScript, testRoot], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the isolated Daemon did not issue a launch grant");
  return result.stdout;
};

test("launches one authenticated empty Console and reloads without work", async ({ page }) => {
  const requests: Array<{ readonly method: string; readonly path: string }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname });
  });

  await page.goto(launchUrl());
  await expect(page).toHaveURL(/\/daemon$/);
  await expect(page.getByRole("heading", { name: "Daemon", exact: true })).toBeVisible();
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await expect(page.getByText("Active managed release", { exact: true })).toBeVisible();
  await expect(page.getByText("0 Projects are registered.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe("");
  expect(await page.evaluate(() => window.sessionStorage.length)).toBe(1);

  await page.reload();
  await expect(page).toHaveURL(/\/daemon$/);
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await expect(page.getByText("0 Projects are registered.", { exact: false })).toBeVisible();

  expect(
    requests.filter(({ method, path }) => method !== "GET" && path !== "/_kojo/session"),
  ).toEqual([]);
});

test("direct navigation has no domain authority", async ({ page }) => {
  await page.goto("http://127.0.0.1:47241/daemon");
  await expect(page.getByRole("heading", { name: "Console access is required" })).toBeVisible();
  await expect(page.getByText("Run kojo ui again", { exact: false })).toBeVisible();
});
