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

test("uses Zaidan composition for every catalogue and keeps it keyboard-operable on narrow layouts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");

  await expect(page.locator('[data-list-composition="zaidan-data-grid"]').first()).toBeVisible();
  await expect(page.locator("[data-recent-changes]")).toBeVisible();
  await expect(page.locator('[data-slot="filters"]').first()).toBeVisible();
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

  await page.goto("http://127.0.0.1:47242/runs");
  await expect(page.locator('[data-list-composition="zaidan-data-grid"]')).toBeVisible();
  await expect(page.locator('[data-slot="filters"]')).toBeVisible();

  await page.goto("http://127.0.0.1:47242/gates");
  await expect(page.locator('[data-list-composition="zaidan-data-grid"]')).toBeVisible();
  await expect(page.locator('[data-slot="filters"]')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("uses filtered Zaidan lists for Phases, Artifacts, and detail resources", async ({ page }) => {
  const runId = "run-component-lists";
  const run = {
    runId,
    projectId: "project-browser-fixture",
    workflowName: "compile",
    revisionId: "c".repeat(64),
    packageGraphId: "d".repeat(64),
    state: "failed",
    admittedAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:01.000Z",
    finishedAt: "2026-09-01T00:00:10.000Z",
    phases: [
      {
        phasePath: "verify",
        attempt: 1,
        kind: "code",
        outcome: "failed",
        description: "Verify the change",
        startedAt: "2026-09-01T00:00:01.000Z",
        endedAt: "2026-09-01T00:00:04.000Z",
        sandboxId: `${runId}/build/1756684801000-1`,
        errorTag: "PermissionBreach",
        verification: {
          envelope: "verify",
          ran: ["typecheck", "test"],
          failed: Array.from(
            { length: 55 },
            (_, index) => `check-${String(index).padStart(2, "0")}`,
          ),
          corrections: 1,
          correctable: true,
        },
        breaches: [{ path: ".kojo/factory.json", outcome: { _tag: "WorkLost" } }],
      },
    ],
    gates: [
      {
        gate: "approval",
        asking: "asking-one",
        description: "Approve",
        actor: "reviewer",
        requestedAt: "2026-09-01T00:00:00.000Z",
        deadlineAt: "2026-09-02T00:00:00.000Z",
        onExpiry: "fail",
        outcome: "answered",
        answerer: "operator",
        choice: "approve",
        reason: "ready",
        answeredAt: "2026-09-01T00:00:00.500Z",
      },
    ],
    sandboxes: [
      {
        sandboxId: `${runId}/build/1756684801000-1`,
        name: "build",
        provider: "docker",
        kind: "isolated",
        branch: "codex/component-lists",
        worktreePath: "/private/component-lists",
        environment: {},
        acquiredAt: "2026-09-01T00:00:01.000Z",
        releasedAt: "2026-09-01T00:00:05.000Z",
        outcome: "failed",
      },
    ],
    artifacts: [
      {
        artifactId: "artifact-one",
        name: "report.txt",
        mediaType: "text/plain",
        size: 12,
        sha256: "e".repeat(64),
      },
    ],
  };
  await page.route(`**/api/v1/runs/${runId}`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(run) }),
  );
  await page.goto(launch());

  await page.goto(`http://127.0.0.1:47242/runs/${runId}?view=table`);
  await expect(page.getByText("1 of 1 Phases")).toBeVisible();
  await page.getByLabel("Find Phases").fill("verify");
  await expect(page.locator(`[data-phase-row="${runId}/verify/1"]`)).toBeVisible();
  await expect(page.getByText("1 of 1 Artifacts")).toBeVisible();

  await page.goto(`http://127.0.0.1:47242/runs/${runId}/phases/verify/1?view=timeline`);
  await expect(page.getByText("55 of 55 Failed checks")).toBeVisible();
  await expect(page.getByText("1 of 1 Permission breaches")).toBeVisible();
  await expect(page.locator('[data-field="failed-checks"] li')).toHaveCount(50);
  await page.locator(`[data-load-more="phase-verify-1-failed-checks"]`).click();
  await expect(page.locator('[data-field="failed-checks"] li')).toHaveCount(55);
  await page.getByLabel("Find Failed checks").fill("check-54");
  await page.getByLabel("Find Permission breaches").fill("factory.json");
  await expect(page).toHaveURL(/phase-verify-1-failed-checks-filter=check-54/);
  await expect(page).toHaveURL(/phase-verify-1-permission-breaches-filter=factory.json/);
  await page.reload();
  await expect(page.getByLabel("Find Failed checks")).toHaveValue("check-54");
  await expect(page.getByLabel("Find Permission breaches")).toHaveValue("factory.json");

  await page.goto(
    `http://127.0.0.1:47242/runs/${runId}/sandboxes/build/1756684801000-1?view=timeline`,
  );
  await expect(page.getByText("1 of 1 Phases in this Sandbox")).toBeVisible();

  await page.goto(`http://127.0.0.1:47242/runs/${runId}/gates/approval/asking-one?view=timeline`);
  await expect(page.getByText("1 of 1 Rebuilt Sandboxes")).toBeVisible();
});

test("reads Recent changes from durable Daemon history after reload and filters by request ID", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/v1/client-requests", async (route) => {
    reads += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        observationVersion: 1,
        instanceId: "daemon-components",
        dataIdentity: "data-components",
        observedAt: "2026-09-01T00:01:00.000Z",
        requests: [
          {
            subject: {
              requestId: "request-durable-change",
              operation: "archiveProject",
              targetKind: "project",
            },
            status: "committed",
          },
        ],
      }),
    });
  });
  await page.goto(launch());
  await page.goto("http://127.0.0.1:47242/");
  await expect(page.locator('[data-recent-request="request-durable-change"]')).toBeVisible();
  await expect(page.locator("[data-recent-changes]")).not.toContainText("confirm");
  await page.getByLabel("Find Recent changes").fill("durable-change");
  await expect(page.getByText("1 of 1 Recent changes")).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-recent-request="request-durable-change"]')).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
});
