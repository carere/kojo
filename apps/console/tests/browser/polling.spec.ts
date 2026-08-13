import { expect, type Page, test } from "@playwright/test";
import { open } from "./harness.ts";

/**
 * The poll rule, graded by counting requests rather than by reading the code.
 *
 * console.md §7: one second while the run is live, and **stop entirely at a terminal status**, so a
 * finished run costs nothing to leave open on a screen. Nothing but a request count can tell a poll
 * that stopped from a poll that happened to be slow.
 */

/** Counts requests to one API path, from the moment it is installed. */
const counting = (page: Page, pathname: string): (() => number) => {
  let seen = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === pathname) seen += 1;
  });
  return () => seen;
};

/** Comfortably more than three poll intervals, so a one-second cadence has to have fired. */
const watching = 3_400;

test("asks again every second while a run can still move", async ({ page }) => {
  const runs = counting(page, "/api/runs");
  await open(page, "busy");
  await expect(page.locator('tr[data-run="run-scout"]')).toBeVisible();

  await page.waitForTimeout(watching);

  expect(runs()).toBeGreaterThanOrEqual(3);
});

test("stops asking for good once every run has finished", async ({ page }) => {
  const runs = counting(page, "/api/runs");
  const gates = counting(page, "/api/gates");
  await open(page, "settled");
  await expect(page.locator('tr[data-run="run-merged"]')).toBeVisible();

  await page.waitForTimeout(watching);

  // One request, and only one, for the whole life of the page.
  expect(runs()).toBe(1);
  // The askings stop with the runs. They cannot know the factory has finished — the run list is the
  // only thing that can — so the second at most is the poll already in flight when the first answer
  // to `/api/runs` arrived.
  expect(gates()).toBeLessThanOrEqual(2);
});
