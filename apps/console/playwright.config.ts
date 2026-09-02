import { defineConfig, devices } from "@playwright/test";

const port = 47241;
const testRoot = "/tmp/kojo-ticket-69-browser";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: [
    "authenticatedConsole.spec.ts",
    "projectCatalogue.spec.ts",
    "runConsole.spec.ts",
    "workflowCatalogue.spec.ts",
    "gateVerdict.spec.ts",
    "artifact.spec.ts",
  ],
  fullyParallel: true,
  reporter: [["list"]],
  // The two catalogue flows each completed near 23 seconds on a two-core GitHub runner. Keep the
  // assertion timeout strict, but do not let the 30-second whole-test budget interrupt a final
  // navigation or action after the Daemon has already returned every earlier assertion.
  timeout: 60_000,
  // The suite uses stated fixture records and deliberate transitions. A retry could hide a state
  // race or timing fault, so failures are meant to be reproducible.
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
    {
      command:
        "bun ../../packages/kojo/tests/support/daemon/authenticatedConsoleServer.ts /tmp/kojo-ticket-74-browser 47244 ../../packages/kojo/console gates",
      url: "http://127.0.0.1:47244/_kojo/compat",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
  ],
});
