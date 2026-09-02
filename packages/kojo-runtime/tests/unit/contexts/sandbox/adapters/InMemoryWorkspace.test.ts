import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import * as InMemoryWorkspace from "../../../../../src/contexts/sandbox/adapters/InMemoryWorkspace.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import { healthy, treeIsHealthy } from "../../../../support/treeIsHealthy.ts";

// The tree the integration test builds for real, said in one literal.
const seed = { "src/health.ts": "export const ok = true\n" };
const cleanTree = { "git status --porcelain": {} };

describe("the in-memory workspace", () => {
  it.effect("answers a check the same way a real worktree does", () =>
    treeIsHealthy.pipe(
      Effect.map((report) => expect(report).toEqual(healthy)),
      Effect.provide(InMemoryWorkspace.layer(seed, { commands: cleanTree })),
    ),
  );

  it.effect("has no host path, and says so", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      expect(Option.isNone(workspace.hostPath)).toBe(true);
    }).pipe(Effect.provide(InMemoryWorkspace.layer(seed))),
  );

  it.effect("hands back a non-zero exit code instead of failing", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      const result = yield* workspace.exec(["bun", "test"]);

      // The check is the one that decides a failing suite is a violation. The adapter only
      // reports what happened, so nothing can catch this by accident.
      expect(result.exitCode).toBe(1);
      expect(result.succeeded).toBe(false);
      expect(result.stdout).toContain("1 fail");
    }).pipe(
      Effect.provide(
        InMemoryWorkspace.layer(seed, {
          commands: { "bun test": { exitCode: 1, stdout: "1 fail\n" } },
        }),
      ),
    ),
  );

  it.effect("refuses a command no test scripted", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      const outcome = yield* workspace.exec(["rm", "-rf", "/"]).pipe(Effect.result);

      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.operation).toBe("exec");
        expect(outcome.failure.target).toBe("rm -rf /");
      }
    }).pipe(Effect.provide(InMemoryWorkspace.layer(seed))),
  );

  it.effect("refuses a path that leaves the root", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace;

      for (const outside of ["../secrets.txt", "src/../../secrets.txt", "/etc/passwd"]) {
        const outcome = yield* workspace.read(outside).pipe(Effect.result);
        expect(Result.isFailure(outcome)).toBe(true);
      }
    }).pipe(Effect.provide(InMemoryWorkspace.layer(seed))),
  );

  it.effect("reads back what it wrote, and forgets what it unlinked", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace;

      yield* workspace.write("src/added.ts", "export const added = 1\n");
      expect(yield* workspace.read("src/added.ts")).toBe("export const added = 1\n");

      const stat = yield* workspace.stat("src/added.ts");
      expect(Option.isSome(stat) && stat.value.kind).toBe("file");
      expect(Option.isSome(stat) && stat.value.size).toBe(23);

      // A directory exists because something is under it — the only honest answer a seeded
      // object can give about one.
      const directory = yield* workspace.stat("src");
      expect(Option.isSome(directory) && directory.value.kind).toBe("directory");

      yield* workspace.unlink("src/added.ts");
      expect(Option.isNone(yield* workspace.stat("src/added.ts"))).toBe(true);
    }).pipe(Effect.provide(InMemoryWorkspace.layer(seed))),
  );

  it.effect("reports an absent path as absent rather than as a fault", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace;
      expect(Option.isNone(yield* workspace.stat("src/nothing.ts"))).toBe(true);
    }).pipe(Effect.provide(InMemoryWorkspace.layer(seed))),
  );

  it.effect("sees a dirty tree as dirty", () =>
    treeIsHealthy.pipe(
      Effect.map((report) => expect(report.clean).toBe(false)),
      Effect.provide(
        InMemoryWorkspace.layer(seed, {
          commands: { "git status --porcelain": { stdout: " M src/health.ts\n" } },
        }),
      ),
    ),
  );
});
