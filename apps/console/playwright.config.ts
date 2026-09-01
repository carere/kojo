import { defineConfig, devices } from "@playwright/test";

const port = 47241;
const testRoot = "/tmp/kojo-ticket-69-browser";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "authenticatedConsole.spec.ts",
  fullyParallel: true,
  reporter: [["list"]],
  // Every assertion here is about a page rendered from a frozen clock over stated records, so a
  // retry could only ever hide a real flake. Failures are meant to be reproducible.
  retries: 0,
  use: { trace: "retain-on-failure" },
  projects: [{ name: "console", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun ../../packages/kojo/tests/support/daemon/authenticatedConsoleServer.ts ${testRoot} ${port} ../../packages/kojo/console`,
    url: `http://127.0.0.1:${port}/_kojo/compat`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  },
});
