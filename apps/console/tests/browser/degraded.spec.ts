import { expect, test } from "@playwright/test";
import { open } from "./harness.ts";

/**
 * The three states console.md §10 says are part of the Console rather than polish.
 *
 * Each of them is the state in which a UI most often shows an error page, a spinner that never ends,
 * or a blank table — and each of them has something useful to say instead.
 */

test("a repository with no factory is told what to run, not shown an error", async ({ page }) => {
  await open(page, "absent");

  await expect(page.getByText("No factory in this repo. Run `kojo init`.")).toBeVisible();
  // Not an error page: the Console is serving, and there is simply nothing to list.
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("a factory with nothing in it says so", async ({ page }) => {
  await open(page, "empty");

  await expect(page.getByText("No runs yet. Run `kojo run <workflow>`.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("an unreachable API keeps the last data on screen behind a retrying banner", async ({
  page,
}) => {
  await open(page, "busy");
  await expect(page.locator('tr[data-run="run-approve"]')).toContainText("approve-hotfix");
  // A banner that is always there says nothing when it matters. This is what makes the assertion
  // below about the failure rather than about the markup.
  await expect(page.locator('[data-notice="retrying"]')).toHaveCount(0);

  // The server is still up; the browser can no longer reach it. That is the failure this state is
  // about — a `kojo ui` that was restarted, a laptop that slept — and it is indistinguishable from
  // the inside of the page.
  await page.route("**/api/**", (route) => route.abort());

  await expect(page.locator('[data-notice="retrying"]')).toBeVisible({ timeout: 15_000 });
  // The whole point: the run list is still there, still saying what it last knew.
  await expect(page.locator('tr[data-run="run-approve"]')).toContainText("approve-hotfix");
  await expect(page.locator('tr[data-run="run-approve"]')).toContainText("in 7h 0m");
});
