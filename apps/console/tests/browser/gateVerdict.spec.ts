import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { expect, test } from "@playwright/test";

const root = "/tmp/kojo-ticket-74-browser";
const grantScript = new URL(
  "../../../../packages/kojo/tests/support/daemon/consoleGrant.ts",
  import.meta.url,
).pathname;

const launchUrl = (): string => {
  const result = spawnSync("bun", [grantScript, root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("the isolated Daemon did not issue a launch grant");
  return result.stdout.replace("/daemon", "/gates");
};

test("shows Unanswered, Recorded, Applied, Expired, and terminal inability without merging them", async ({
  page,
}) => {
  await page.goto(launchUrl());

  const open = async (run: string) => {
    await page.locator(`[data-queued="${run}"] [data-queued-open]`).click();
    await expect(page.locator("[data-detail-panel] [data-answering]")).toBeVisible();
  };

  await open("run-unanswered");
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
  await page.locator('[data-queued="run-answerable"] [data-queued-open]').click();
  const panel = page.locator("[data-detail-panel]");
  await panel.locator('[data-gate-choice="approve"]').click();
  await expect(panel.locator("[data-answering-verdict]")).toContainText(userInfo().username);
  // This fixture has no Runner continuation. Keep Recorded separate from Applied after the Daemon
  // attributes the Verdict.
  await expect(panel.locator("[data-answering]")).toHaveAttribute("data-answering", "idle");
});
