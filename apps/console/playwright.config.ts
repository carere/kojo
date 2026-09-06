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
    "reconnect.spec.ts",
    "daemonComponents.spec.ts",
    "polling.spec.ts",
    "waterfall.spec.ts",
  ],
  fullyParallel: true,
  // The browser files share three real Daemon fixtures. A two-core CI Host cannot run two complete
  // Console clients and their Daemon query loops without starving hydration and stable DOM updates.
  // One worker limits contention between Console clients and their shared Daemon fixtures.
  workers: 1,
  reporter: [["list"]],
  // Allow time for tests with several authenticated navigations on a two-core CI Host.
  // Individual assertions retain their default timeout so an absent state fails promptly.
  timeout: 60_000,
  // The suite uses stated fixture records and deliberate transitions. A retry could hide a state
  // race or timing fault, so failures are meant to be reproducible.
  retries: 0,
  use: { trace: "retain-on-failure" },
  projects: [{ name: "console", use: { ...devices["Desktop Chrome"] } }],
  // Wait for seed completion. The compatibility endpoint opens before asynchronous setup ends.
  webServer: [
    {
      command: `bun ../../packages/kojo/tests/support/daemon/authenticatedConsoleServer.ts ${testRoot} ${port} ../../packages/kojo/console`,
      wait: { stdout: /Kojo browser fixture ready/ },
      timeout: 30_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
    {
      command:
        "bun ../../packages/kojo/tests/support/daemon/authenticatedConsoleServer.ts /tmp/kojo-ticket-70-browser 47242 ../../packages/kojo/console projects",
      wait: { stdout: /Kojo browser fixture ready/ },
      timeout: 30_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
    {
      command:
        "bun ../../packages/kojo/tests/support/daemon/authenticatedConsoleServer.ts /tmp/kojo-ticket-74-browser 47244 ../../packages/kojo/console gates",
      wait: { stdout: /Kojo browser fixture ready/ },
      timeout: 30_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
  ],
});
