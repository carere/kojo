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

test("shows a Daemon Run and builds its initial Waterfall only from completed Phase records", async ({
  page,
}) => {
  await page.route("**/api/v1/runs/run-no-trigger", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId: "run-no-trigger",
        projectId: "project-browser-fixture",
        workflowName: "compile",
        revisionId: "c".repeat(64),
        packageGraphId: "d".repeat(64),
        state: "succeeded",
        admittedAt: "2026-09-01T00:00:00.000Z",
        startedAt: "2026-09-01T00:00:01.000Z",
        finishedAt: "2026-09-01T00:00:12.000Z",
        phases: [
          {
            phasePath: "prepare",
            attempt: 1,
            kind: "code",
            outcome: "succeeded",
            description: "Prepare the retained source",
            startedAt: "2026-09-01T00:00:01.000Z",
            endedAt: "2026-09-01T00:00:04.000Z",
            result: null,
          },
          {
            phasePath: "compile",
            attempt: 1,
            kind: "code",
            outcome: "succeeded",
            description: "Compile the retained source",
            startedAt: "2026-09-01T00:00:04.000Z",
            endedAt: "2026-09-01T00:00:12.000Z",
            result: null,
          },
        ],
      }),
    });
  });
  await page.goto(launch());
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await page.goto(`${origin}/runs/run-no-trigger`);

  await expect(page.locator('[data-run-header="run-no-trigger"]')).toBeVisible();
  await expect(page.locator('[data-stamp="project"]')).toContainText("project-browser-fixture");
  await expect(page.locator('[data-stamp="revision"]')).toContainText("cccccccccccc");
  await expect(page.locator('[data-stamp="execution"]')).toContainText("succeeded");
  await expect(page.locator("[data-waterfall]")).toBeVisible();
  await expect(page.locator("[data-phase]")).toHaveCount(2);
  await expect(page.locator('[data-phase="run-no-trigger/prepare/1"]')).toBeVisible();
  await expect(page.locator('[data-phase="run-no-trigger/compile/1"]')).toBeVisible();
  await expect(page.getByText("not-yet-recorded", { exact: true })).toHaveCount(0);
});

test("shows the exact pinned-content fault and repair remedy for a held Run", async ({ page }) => {
  await page.route("**/api/v1/runs/run-held-content", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId: "run-held-content",
        projectId: "project-browser-fixture",
        workflowName: "compile",
        revisionId: "e".repeat(64),
        packageGraphId: "f".repeat(64),
        state: "held",
        queueReason: "pinned-content",
        executionFault: {
          code: "RETAINED_CONTENT_CORRUPT",
          detail: "the pinned package file does not match its retained hash",
          remedy: "Restore the exact retained package bytes. Do not refresh this Run.",
        },
        admittedAt: "2026-09-01T00:00:00.000Z",
        phases: [],
      }),
    });
  });
  await page.goto(launch());
  await page.goto(`${origin}/runs/run-held-content`);

  await expect(page.getByText("held", { exact: true })).toBeVisible();
  await expect(page.locator('[data-stamp="execution"]')).toContainText("pinned-content");
  await expect(page.getByText("Pinned content fault: RETAINED_CONTENT_CORRUPT")).toBeVisible();
  await expect(
    page.getByText("the pinned package file does not match its retained hash"),
  ).toBeVisible();
  await expect(
    page.getByText("Remedy: Restore the exact retained package bytes. Do not refresh this Run."),
  ).toBeVisible();
});
