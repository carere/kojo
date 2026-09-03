import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

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

test("paginates and filters the complete Run table with durable URL state", async ({ page }) => {
  await page.route("**/api/v1/runs", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as { runs: ReadonlyArray<Record<string, unknown>> };
    const template = {
      runId: "run-page-template",
      projectId: "project-browser-fixture",
      workflowName: "compile",
      revisionId: "c".repeat(64),
      packageGraphId: "d".repeat(64),
      state: "succeeded",
      admittedAt: "2026-09-01T00:00:00.000Z",
      startedAt: "2026-09-01T00:00:01.000Z",
      finishedAt: "2026-09-01T00:00:02.000Z",
    };
    const runs = Array.from({ length: 51 }, (_, index) => ({
      ...template,
      runId: `run-page-${String(index + 1).padStart(2, "0")}`,
      workflowName: `workflow-page-${String(index + 1).padStart(2, "0")}`,
      state: "succeeded",
    }));
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({ ...snapshot, runs }),
    });
  });
  await page.goto(launch());
  await page.goto(`${origin}/runs`);
  await expect(page.locator("[data-run]")).toHaveCount(50);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator("[data-run]")).toHaveCount(1);
  await expect(page).toHaveURL(/cursor=50/);
  await page.getByLabel("Find Runs").fill("run-page-51");
  await expect(page.locator("[data-run]")).toHaveCount(1);
  await expect(page).not.toHaveURL(/cursor=/);
});

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
  await expect(page.locator('[data-stamp="graph"]')).toContainText("dddddddddddd");
  await expect(page.locator('[data-stamp="execution"]')).toContainText("succeeded");
  await expect(page.locator("[data-waterfall]")).toBeVisible();
  await expect(page.locator("[data-phase]")).toHaveCount(2);
  await expect(page.locator('[data-phase="run-no-trigger/prepare/1"]')).toBeVisible();
  await expect(page.locator('[data-phase="run-no-trigger/compile/1"]')).toBeVisible();
  await expect(page.getByText("not-yet-recorded", { exact: true })).toHaveCount(0);
});

test("renders persisted Gate and Sandbox Trace records and accepts their absent optional fields", async ({
  page,
}) => {
  const runId = "run-persisted-trace";
  const asking = "gate/release/approve/1";
  const sandboxId = `${runId}/release/1000-1`;
  await page.route(`**/api/v1/runs/${runId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId,
        projectId: "project-browser-fixture",
        workflowName: "release",
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        state: "succeeded",
        admittedAt: "2026-09-01T00:00:00.000Z",
        startedAt: "2026-09-01T00:00:00.500Z",
        finishedAt: "2026-09-01T00:00:04.000Z",
        phases: [
          {
            phasePath: "publish",
            attempt: 1,
            kind: "code",
            outcome: "succeeded",
            description: "Publish the release evidence",
            startedAt: "2026-09-01T00:00:01.000Z",
            endedAt: "2026-09-01T00:00:02.000Z",
            sandboxId,
          },
        ],
        gates: [
          {
            gate: "approve",
            asking,
            description: "Approve the release",
            actor: "release-manager",
            requestedAt: "2026-09-01T00:00:02.000Z",
            deadlineAt: "2026-09-01T01:00:02.000Z",
            onExpiry: "reject",
            outcome: "expired",
          },
        ],
        sandboxes: [
          {
            sandboxId,
            name: "release",
            provider: "no-sandbox",
            kind: "none",
            branch: "kojo/release",
            worktreePath: "/tmp/release",
            environment: { KOJO_RUN_ID: runId },
            acquiredAt: "2026-09-01T00:00:01.000Z",
            releasedAt: "2026-09-01T00:00:03.000Z",
            outcome: "released",
          },
        ],
      }),
    });
  });
  await page.goto(launch());
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();

  await page.goto(`${origin}/runs/${runId}`);
  await expect(page.locator('[data-scope="sandbox"]')).toHaveCount(1);
  await expect(page.locator('[data-stamp="branch"]')).toContainText("kojo/release");

  await page.goto(`${origin}/runs/${runId}/gates/approve/${encodeURIComponent(asking)}`);
  await expect(page.locator('[data-gate-outcome="expired"]')).toBeVisible();
  await expect(page.locator('[data-gate-from="trace"]')).toBeVisible();

  await page.goto(`${origin}/runs/${runId}/sandboxes/release/1000-1`);
  await expect(page.getByText("no-sandbox", { exact: true })).toBeVisible();
  await expect(page.getByText("released", { exact: true }).first()).toBeVisible();
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
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await page.goto(`${origin}/runs/run-held-content`);

  await expect(page.getByText("held", { exact: true })).toBeVisible();
  await expect(page.locator('[data-stamp="graph"]')).toContainText("ffffffffffff");
  await expect(page.locator('[data-stamp="execution"]')).toContainText("pinned-content");
  await expect(page.getByText("Pinned content fault: RETAINED_CONTENT_CORRUPT")).toBeVisible();
  await expect(
    page.getByText("the pinned package file does not match its retained hash"),
  ).toBeVisible();
  await expect(
    page.getByText("Remedy: Restore the exact retained package bytes. Do not refresh this Run."),
  ).toBeVisible();
});

test("requires acknowledgement and separates durable cancellation intent from confirmation", async ({
  page,
}) => {
  let cancelled = false;
  await page.route("**/api/v1/runs/run-cancel-control/actions/cancel", async (route) => {
    cancelled = true;
    await route.fulfill({
      contentType: "application/json",
      status: 202,
      body: JSON.stringify({
        kind: "cancel",
        runId: "run-cancel-control",
        cancellation: "requested",
        executionStopped: false,
        state: "executing",
      }),
    });
  });
  await page.route("**/api/v1/runs/run-cancel-control", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId: "run-cancel-control",
        projectId: "project-browser-fixture",
        workflowName: "compile",
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        state: "executing",
        admittedAt: "2026-09-01T00:00:00.000Z",
        startedAt: "2026-09-01T00:00:01.000Z",
        phases: [],
        ...(cancelled
          ? {
              cancellation: {
                state: "requested",
                source: "run",
                requestedAt: "2026-09-01T00:00:02.000Z",
              },
              cleanup: { state: "pending" },
            }
          : {}),
      }),
    });
  });
  await page.goto(launch());
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await page.goto(`${origin}/runs/run-cancel-control`);

  const cancel = page.getByRole("button", { name: "Cancel Run" });
  await expect(cancel).toBeDisabled();
  await page
    .getByText("I understand that cancellation does not undo completed effects", { exact: false })
    .click();
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(
    page.getByText("Cancellation intent is durable. Execution stop is not confirmed.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Cancellation requested — execution stop is not confirmed"),
  ).toBeVisible();
  await expect(page.getByText("Resource cleanup: pending")).toBeVisible();
});

test("requires the exact Action ID, reason, and possible-duplication acknowledgement", async ({
  page,
}) => {
  const actionId = "action_exact_publish";
  let authorized = false;
  await page.route("**/api/v1/runs/run-uncertain/actions/retry-uncertain", async (route) => {
    const body = route.request().postDataJSON() as {
      readonly operation: string;
      readonly target: { readonly kind: string; readonly parts: ReadonlyArray<string> };
      readonly arguments: { readonly reason: string };
      readonly preconditions: { readonly possibleDuplicationAcknowledged: boolean };
    };
    expect(body.operation).toBe("retryUncertainAction");
    expect(body.target).toEqual({
      identityVersion: 1,
      kind: "runAction",
      parts: ["run-uncertain", actionId],
    });
    expect(body.arguments.reason).toBe("The provider has no result lookup.");
    expect(body.preconditions.possibleDuplicationAcknowledged).toBe(true);
    authorized = true;
    await route.fulfill({
      contentType: "application/json",
      status: 202,
      body: JSON.stringify({
        kind: "retry-uncertain",
        runId: "run-uncertain",
        actionId,
        uncertaintyRevision: 1,
        state: "retry-authorized",
      }),
    });
  });
  await page.route("**/api/v1/runs/run-uncertain", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId: "run-uncertain",
        projectId: "project-browser-fixture",
        workflowName: "publish",
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        state: authorized ? "queued" : "held",
        admittedAt: "2026-09-01T00:00:00.000Z",
        phases: [],
        uncertainty: {
          actionId,
          revisionId: "a".repeat(64),
          phasePath: "publish",
          attempt: 1,
          inputHash: "c".repeat(64),
          recoveryPolicy: "unresolved",
          state: authorized ? "retry-authorized" : "unresolved",
          uncertaintyRevision: 1,
          evidence: {
            kind: "unresolved",
            detail: "the process output was lost",
            observedAt: "2026-09-01T00:00:02.000Z",
          },
        },
      }),
    });
  });
  await page.goto(launch());
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await page.goto(`${origin}/runs/run-uncertain`);

  await expect(page.getByText("External action uncertainty: unresolved")).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry exact action" });
  await expect(retry).toBeDisabled();
  await page.getByLabel("Exact action ID").fill("action_wrong");
  await page.getByLabel("Reason").fill("The provider has no result lookup.");
  await page
    .getByText("I acknowledge that this retry can duplicate the external action.", { exact: true })
    .click();
  await expect(retry).toBeDisabled();
  await page.getByLabel("Exact action ID").fill(actionId);
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(
    page.getByText(`Retry authorization is durable for exact Action ${actionId}.`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("External action uncertainty: retry-authorized")).toBeVisible();
});

test("shows an interrupted sibling as recovery and never as the cancelled target", async ({
  page,
}) => {
  await page.route("**/api/v1/runs/run-interrupted-sibling", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId: "run-interrupted-sibling",
        projectId: "project-browser-fixture",
        workflowName: "publish-sibling",
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        state: "held",
        admittedAt: "2026-09-01T00:00:00.000Z",
        phases: [],
        recovery: {
          state: "interrupted-sibling",
          detail: "the forced Stop targeted another Run; this sibling can resume after recovery",
        },
        cleanup: { state: "pending" },
      }),
    });
  });
  await page.goto(launch());
  await page.goto(`${origin}/runs/run-interrupted-sibling`);
  await expect(page.getByText("Interrupted sibling recovery", { exact: true })).toBeVisible();
  await expect(page.getByText(/forced Stop targeted another Run/)).toBeVisible();
  await expect(page.getByText("Resource cleanup: pending", { exact: true })).toBeVisible();
  await expect(page.getByText(/Cancellation requested/)).toHaveCount(0);
});
