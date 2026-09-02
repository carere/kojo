import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const root = "/tmp/kojo-ticket-69-browser";
const origin = "http://127.0.0.1:47241";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launch = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the Run fixture Daemon did not issue a grant");
  return result.stdout;
};

const run = (state: "queued" | "succeeded") => ({
  runId: `run-${state}`,
  projectId: "project-browser-fixture",
  workflowName: "compile",
  revisionId: "c".repeat(64),
  packageGraphId: "d".repeat(64),
  state,
  admittedAt: "2026-09-01T00:00:00.000Z",
  ...(state === "succeeded"
    ? {
        startedAt: "2026-09-01T00:00:01.000Z",
        finishedAt: "2026-09-01T00:00:02.000Z",
      }
    : { queueReason: "runner-starting" }),
});

test("asks the authenticated Daemon again every second while a Run can still move", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/v1/runs", async (route) => {
    requests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run("queued")] }),
    });
  });

  await page.goto(launch());
  await page.goto(`${origin}/runs`);
  await expect(page.locator('[data-run="run-queued"]')).toBeVisible();
  await page.waitForTimeout(3_400);

  expect(requests).toBeGreaterThanOrEqual(3);
});

test("stops authenticated Daemon polling after every Run reaches a terminal state", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/v1/runs", async (route) => {
    requests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ runs: [run("succeeded")] }),
    });
  });

  await page.goto(launch());
  await page.goto(`${origin}/runs`);
  await expect(page.locator('[data-run="run-succeeded"]')).toBeVisible();
  await page.waitForTimeout(3_400);

  expect(requests).toBe(1);
});
