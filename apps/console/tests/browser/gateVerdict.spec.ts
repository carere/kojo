import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const root = "/tmp/kojo-ticket-74-browser";
const catalogueReadyTimeout = 30_000;
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launchUrl = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the isolated Daemon did not issue a launch grant");
  return result.stdout.replace("/daemon", "/gates");
};

test("paginates and filters every Gate state with durable URL state", async ({ page }) => {
  await page.route("**/api/v1/askings", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as { askings: ReadonlyArray<Record<string, unknown>> };
    const template = snapshot.askings[0] as
      | (Record<string, unknown> & { identity?: Record<string, unknown> })
      | undefined;
    if (template === undefined) throw new Error("the Gate fixture has no pagination template");
    const askings = Array.from({ length: 51 }, (_, index) => ({
      ...template,
      identity: {
        ...template.identity,
        runId: `run-gate-page-${String(index + 1).padStart(2, "0")}`,
      },
      token: `gate-token-page-${index + 1}`,
      state: "unanswered",
      verdict: undefined,
      appliedAt: undefined,
    }));
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({ ...snapshot, askings }),
    });
  });
  await page.goto(launchUrl());
  await expect(page.getByLabel("Find Gates")).toBeVisible({ timeout: catalogueReadyTimeout });
  await expect(page.locator("[data-queued]")).toHaveCount(50, {
    timeout: catalogueReadyTimeout,
  });
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator("[data-queued]")).toHaveCount(1);
  await expect(page).toHaveURL(/cursor=50/);
  await page.getByLabel("Find Gates").fill("run-gate-page-51");
  await expect(page.locator("[data-queued]")).toHaveCount(1);
  await expect(page).not.toHaveURL(/cursor=/);
});

test("defaults the Gate table to every status and keeps complete review links and states", async ({
  page,
}) => {
  await page.goto(launchUrl());
  await expect(page.getByLabel("Gate state")).toHaveValue("all");
  await expect(page.locator("[data-queued]")).toHaveCount(6);
  await page.getByLabel("Gate state").selectOption("applied");
  await expect(page.locator("[data-queued]")).toHaveCount(1);
  await expect(page).toHaveURL(/state=applied/);
  await page.getByLabel("Gate state").selectOption("all");

  const open = async (run: string) => {
    await page.locator(`[data-queued="${run}"] [data-queued-open]`).click();
    await expect(page.locator("[data-detail-panel] [data-answering]")).toBeVisible();
  };

  await open("run-unanswered");
  const panel = page.locator("[data-detail-panel]");
  await expect(panel.getByText("Decide the unanswered release", { exact: true })).toBeVisible();
  await expect(panel.getByText("release-manager", { exact: true })).toBeVisible();
  await expect(panel.getByText("if it expires", { exact: true })).toBeVisible();
  await expect(panel.getByText("fail", { exact: true })).toBeVisible();
  await expect(panel.locator("[data-gate-reason]")).toBeVisible();
  await expect(panel.locator("[data-gate-choice]")).toHaveCount(2);
  await expect(page.locator("[data-detail-panel] [data-answering]")).toHaveAttribute(
    "data-answering",
    "waiting",
  );
  await expect(
    page.locator("[data-detail-panel]").getByText("Record Verdict", { exact: true }),
  ).toBeVisible();

  await page.goto(launchUrl());
  await open("run-recorded");
  await expect(page.locator("[data-detail-panel] [data-answering]")).toHaveAttribute(
    "data-answering",
    "idle",
  );

  await page.goto(launchUrl());
  await open("run-applied");
  await expect(page.locator("[data-detail-panel] [data-answering]")).toHaveAttribute(
    "data-answering",
    "applied",
  );

  await page.goto(launchUrl());
  await open("run-expired");
  await expect(page.locator("[data-detail-panel] [data-answering]")).toHaveAttribute(
    "data-answering",
    "expired",
  );

  await page.goto(launchUrl());
  await open("run-unable");
  await expect(page.locator("[data-detail-panel] [data-answering]")).toHaveAttribute(
    "data-answering",
    "unable",
  );
  await expect(
    page.locator("[data-detail-panel]").getByText("the run cannot apply it", { exact: false }),
  ).toBeVisible();
});

test("records a Verdict with the Daemon OS user as Answerer", async ({ page }) => {
  await page.goto(launchUrl());
  const answerable = page.locator('[data-queued="run-answerable"] [data-queued-open]');
  await answerable.evaluate((element) => element.setAttribute("data-live-row-probe", "stable"));
  await page.waitForTimeout(1_200);
  await expect(answerable).toHaveAttribute("data-live-row-probe", "stable");
  await answerable.click();
  const panel = page.locator("[data-detail-panel]");
  await panel.locator('[data-gate-choice="approve"]').click();
  await expect(panel.locator("[data-answering-verdict]")).toContainText(userInfo().username);
  // This fixture has no Runner continuation. Keep Recorded separate from Applied after the Daemon
  // attributes the Verdict.
  await expect(panel.locator("[data-answering]")).toHaveAttribute("data-answering", "idle");
});
