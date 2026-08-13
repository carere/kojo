import { defineConfig, devices } from "@playwright/test";
import { realPort, servers } from "./tests/browser/harness.ts";

/**
 * The browser tier: the real server, the real build, stated records.
 *
 * console.md §11 fixes this shape. Every server below is `kojo ui` — the same command a person runs
 * — started with `--fixtures`, which swaps the SQLite readers for in-memory ones and opens no
 * database at all. So a test here exercises the real routes, the real Query wiring and the real
 * components, and the only thing that is not real is the data.
 *
 * **Four servers rather than four requests, because three of the states are properties of the
 * server.** Whether a repository has a factory, and whether anything in it is still moving, are
 * decided when `kojo ui` starts. One server could not be a repository with no factory for one test
 * and a busy one for the next.
 *
 * The fourth broken state — an unreachable API — is the only one the page can be put into from
 * outside, and it is: the test aborts the requests after the first load.
 */
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  reporter: [["list"]],
  // Every assertion here is about a page rendered from a frozen clock over stated records, so a
  // retry could only ever hide a real flake. Failures are meant to be reproducible.
  retries: 0,
  use: { trace: "retain-on-failure" },
  projects: [{ name: "console", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    /**
     * **The one server here that reads a database instead of a fixture.**
     *
     * It stamps a factory, runs a workflow with `kojo run`, and serves the trace that run wrote —
     * see `tests/browser/realFactory.ts`. Every other server below states its records, and stated
     * records were how a shape the SQLite readers send every time went unseen through eighty-five
     * green specs (adr/trace/0003).
     *
     * It is given longer to come up than the others because it does more than open a port: `kojo
     * init` writes a factory and `kojo run` executes a workflow before the server is started at all.
     */
    {
      command: `bun tests/browser/realFactory.ts --port ${realPort}`,
      url: `http://127.0.0.1:${realPort}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    },
    ...servers.map((server) => ({
      // Through `bun`, and through the CLI's own entry point: the Console has to be served by the
      // thing that ships, not by a harness that happens to mount the same router.
      command: `bun ../../packages/kojo/src/main.ts ui --port ${server.port} --fixtures ${server.fixtures}`,
      // Ready when the API answers, not when the port accepts. `Layer.launch` opens the socket and
      // builds the router in one step, and waiting on the health document proves both happened.
      url: `http://127.0.0.1:${server.port}/api/health`,
      reuseExistingServer: false,
      stdout: "pipe" as const,
      stderr: "pipe" as const,
    })),
  ],
});
