import { expect, test } from "@playwright/test";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
};

const launchUrl = required("KOJO_SHIPPED_LAUNCH_URL");
const projectId = required("KOJO_SHIPPED_PROJECT_ID");
const runId = required("KOJO_SHIPPED_RUN_ID");
const gateName = required("KOJO_SHIPPED_GATE_NAME");
const asking = required("KOJO_SHIPPED_GATE_ASKING");
const sandboxName = required("KOJO_SHIPPED_SANDBOX_NAME");
const acquisition = required("KOJO_SHIPPED_SANDBOX_ACQUISITION");

test("renders actual shipped Daemon records through one authenticated browser session", async ({
  page,
}) => {
  await page.goto(launchUrl);
  await expect(page).toHaveURL(/\/daemon$/);
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
  await expect(page.getByText("Active managed release", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe("");

  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/projects/${projectId}`);
  await expect(page.getByText(projectId, { exact: false }).first()).toBeVisible();

  await page.goto(`${origin}/runs/${runId}`);
  await expect(page.locator(`[data-run-header="${runId}"]`)).toBeVisible();
  await expect(page.locator('[data-stamp="project"]')).toContainText(projectId);
  await expect(page.locator('[data-stamp="execution"]')).toContainText("succeeded");
  await expect(page.locator("[data-waterfall]")).toBeVisible();
  expect(await page.locator("[data-phase]").count()).toBeGreaterThanOrEqual(2);
  expect(await page.locator('[data-scope="sandbox"]').count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Captured Artifacts", { exact: true })).toBeVisible();

  const wire = await page.evaluate(async (selectedRunId) => {
    const stored = window.sessionStorage.getItem("kojo.browser-session.v1");
    if (stored === null) throw new Error("the authenticated browser session is absent");
    const session = JSON.parse(stored) as { readonly credential: string };
    const response = await fetch(`/api/v1/runs/${encodeURIComponent(selectedRunId)}`, {
      headers: { authorization: `Bearer ${session.credential}` },
    });
    if (!response.ok) throw new Error(`the Run wire response failed with ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }, runId);
  for (const optional of [
    "queueReason",
    "executionFault",
    "cancellation",
    "recovery",
    "cleanup",
    "uncertainty",
  ]) {
    expect(Object.hasOwn(wire, optional), `${optional} must be absent, not null`).toBe(false);
  }
  const phases = wire.phases as ReadonlyArray<Record<string, unknown>>;
  expect(phases.length).toBeGreaterThanOrEqual(2);
  expect(phases.every((phase) => !Object.hasOwn(phase, "errorTag"))).toBe(true);

  await page.goto(`${origin}/runs/${runId}/gates/${gateName}/${asking}`);
  await expect(page.locator('[data-gate-outcome="answered"]')).toBeVisible();
  await expect(page.locator('[data-gate-from="trace"]')).toBeVisible();

  await page.goto(`${origin}/runs/${runId}/sandboxes/${sandboxName}/${acquisition}`);
  await expect(page.getByText("no-sandbox", { exact: true })).toBeVisible();
  await expect(page.getByText("released", { exact: true }).first()).toBeVisible();

  await page.goto(`${origin}/runs/${runId}`);
  const artifact = page.locator("[data-published-artifact-display]");
  await expect(artifact).toHaveCount(1);
  await artifact.click();
  await expect(page.locator("[data-published-artifact-content]")).toHaveText(
    "actual shipped Daemon record for native-release-evidence\n",
  );

  const session = await page.evaluate(() =>
    window.sessionStorage.getItem("kojo.browser-session.v1"),
  );
  expect(session).not.toBeNull();
  const unauthenticated = await page.request.get(`${origin}/api/v1/runs/${runId}`);
  expect(unauthenticated.status()).toBe(401);
});
