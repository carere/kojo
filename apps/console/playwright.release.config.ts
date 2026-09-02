import { defineConfig, devices } from "@playwright/test";

/** @public Loaded directly by Playwright in the shipped native-Host evidence job. */
export default defineConfig({
  testDir: "./tests/release",
  testMatch: "shippedDaemon.spec.ts",
  fullyParallel: false,
  reporter: [["list"]],
  retries: 0,
  use: { trace: "retain-on-failure" },
  projects: [{ name: "shipped-daemon", use: { ...devices["Desktop Chrome"] } }],
});
