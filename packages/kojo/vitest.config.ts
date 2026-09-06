import { defineConfig } from "vitest/config";

// One Vitest project per test tier, per AGENTS.md. Unit tests never touch a real adapter, so
// they get no setup file and no environment beyond the default. Integration, native Host, and
// shipped macOS checks have separate projects. The Console uses manual UI checks.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Real adapters spawn real processes. The default five seconds is a budget for a pure
          // function, not for `git init` plus a commit.
          // Process-heavy tests keep their own domain deadlines. Give those assertions enough
          // runner time to complete when the CI Host is slower than a development Host.
          testTimeout: 60_000,
          // Run one file at a time. Process-heavy tests share Host resources and use domain
          // deadlines that must not depend on load from other test files.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "host",
          include: ["tests/host/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "release-macos",
          include: ["tests/release/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 1_200_000,
        },
      },
    ],
  },
});
