import { expect, type Page, test } from "@playwright/test";
import { frozenNow, open } from "./harness.ts";

/** One row, found by the run it is about rather than by its position in the table. */
const rowOf = (page: Page, runId: string) => page.locator(`tr[data-run="${runId}"]`);

const hour = 60 * 60 * 1_000;

test.describe("the run list", () => {
  test("shows id, workflow, status, open gate and deadline", async ({ page }) => {
    await open(page, "busy");

    await expect(page.getByRole("columnheader")).toHaveText([
      "Run",
      "Workflow",
      "Status",
      "Open gate",
      "Deadline",
    ]);

    const waiting = rowOf(page, "run-approve");
    await expect(waiting).toContainText("run-approve");
    await expect(waiting).toContainText("hotfix");
    await expect(waiting).toContainText("suspended");
    await expect(waiting).toContainText("approve-hotfix");
    await expect(waiting).toContainText("in 7h 0m");
  });

  test("names every status a run can be in", async ({ page }) => {
    await open(page, "busy");

    // A run the writer has never stamped is executing, which is not the same as an unknown state.
    await expect(rowOf(page, "run-scout")).toContainText("executing");
    await expect(rowOf(page, "run-merged")).toContainText("succeeded");
    await expect(rowOf(page, "run-broken")).toContainText("failed");
    await expect(rowOf(page, "run-stale")).toContainText("suspended");
  });

  test("says nothing is waiting rather than leaving the columns blank", async ({ page }) => {
    await open(page, "busy");

    const running = rowOf(page, "run-build");
    await expect(running).toContainText("feature");
    // An em dash in both the gate and the deadline column: a run with no open gate is a fact, and a
    // blank cell would read as a value the Console failed to load.
    await expect(running.locator("td").nth(3)).toHaveText("—");
    await expect(running.locator("td").nth(4)).toHaveText("—");
  });

  test("reads a deadline that has passed as overdue", async ({ page }) => {
    await open(page, "busy");

    await expect(rowOf(page, "run-stale")).toContainText("overdue by 2h 0m");
  });

  test("reads the current time from the injected clock, never from the machine", async ({
    page,
  }) => {
    // The fixtures are written against 2026-03-01, which is in the past. A component calling
    // `Date.now()` would report this gate as months overdue, so the first assertion alone proves the
    // clock is injected; moving the clock eight hours and watching the same row cross its deadline
    // proves the Console is reading the injected value rather than any other fixed one.
    await open(page, "busy", frozenNow);
    await expect(rowOf(page, "run-approve")).toContainText("in 7h 0m");

    await open(page, "busy", frozenNow + 8 * hour);
    await expect(rowOf(page, "run-approve")).toContainText("overdue by 1h 0m");
  });
});
