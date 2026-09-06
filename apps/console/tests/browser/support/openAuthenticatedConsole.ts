import { expect, type Page } from "@playwright/test";

export const openAuthenticatedConsole = async (page: Page, launchUrl: string): Promise<void> => {
  await page.goto(launchUrl);
  // The load event does not wait for the launch grant exchange. Do not leave this page until the
  // Console has stored its browser session, or the next navigation can lose access.
  await expect(page.getByText("Access active", { exact: true })).toBeVisible();
};
