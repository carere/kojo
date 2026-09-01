import { defineConfig, devices } from "@playwright/test";

const port = 47241;
const testRoot = "/tmp/kojo-ticket-69-browser";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: [
    "authenticatedConsole.spec.ts",
    "projectCatalogue.spec.ts",
    "workflowCatalogue.spec.ts",
  ],
  fullyParallel: true,
  reporter: [["list"]],
  // Every assertion here is about a page rendered from a frozen clock over stated records, so a
  // retry could only ever hide a real flake. Failures are meant to be reproducible.
  retries: 0,
  use: { trace: "retain-on-failure" },
  projects: [{ name: "console", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `bun ../../packages/kojo/tests/support/daemon/authenticatedConsoleServer.ts ${testRoot} ${port} ../../packages/kojo/console`,
      url: `http://127.0.0.1:${port}/_kojo/compat`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
    {
      command:
        "bun ../../packages/kojo/tests/support/daemon/authenticatedConsoleServer.ts /tmp/kojo-ticket-70-browser 47242 ../../packages/kojo/console projects",
      url: "http://127.0.0.1:47242/_kojo/compat",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
    {
      command:
        "bun ../../packages/kojo/tests/support/daemon/authenticatedConsoleServer.ts /tmp/kojo-ticket-71-browser 47243 ../../packages/kojo/console workflows",
      url: "http://127.0.0.1:47243/_kojo/compat",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
  ],
});
