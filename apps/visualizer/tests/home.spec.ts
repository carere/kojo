import { expect, test } from "@playwright/test";

test("shows the Kojo starting point", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "The new Kojo starts here." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready" })).toBeVisible();
});
