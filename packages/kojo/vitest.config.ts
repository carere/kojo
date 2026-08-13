import { defineConfig } from "vitest/config";

// One Vitest project per test tier, per AGENTS.md. Unit tests never touch a real adapter, so
// they get no setup file and no environment beyond the default. The integration and browser
// projects are added by the tickets that introduce their first test.
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
          testTimeout: 30_000,
          // One file at a time. These tests spawn whole processes, build containers, and share one
          // Docker daemon, so running the files in parallel makes them compete for the resources
          // they are measuring — and a lane that failed because the machine was busy is a red test
          // that says nothing about the code.
          //
          // **It does not fix the exit-127 rebuild fault.** An earlier version of this comment said
          // it did; that measurement did not reproduce — serialised, through this task, the container
          // lane still failed 3 runs in 4 while the fixture sat under `$TMPDIR`. What addressed that
          // is `fixtureRoot` in `lane.test.ts`. This setting stands on its own reason and nothing
          // else.
          fileParallelism: false,
        },
      },
    ],
  },
});
