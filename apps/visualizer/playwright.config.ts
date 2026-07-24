import { defineConfig } from "@playwright/test";

export default defineConfig({
  outputDir: "../../.moon/cache/test-results/apps/visualizer",
  reporter: "list",
  testDir: "./tests",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun vite --host 127.0.0.1 --port 4173",
    reuseExistingServer: true,
    url: "http://127.0.0.1:4173",
  },
});
