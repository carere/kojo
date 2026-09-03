// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide. BunServices reaches none of that.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import * as BindMountWorkspace from "../../../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import { defaultTrunk } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import { healthy, treeIsHealthy } from "../../../../support/treeIsHealthy.ts";

/**
 * A real git worktree in a temporary directory, built through the port itself.
 *
 * Identity is passed with `-c` rather than written to a config file, so the test does not depend
 * on whatever the machine running it has set, and leaves nothing behind when the scope closes.
 */
const worktree = <A, E>(use: Effect.Effect<A, E, Workspace>) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "kojo-workspace-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    return yield* setUp.pipe(
      Effect.andThen(use),
      Effect.provide(BindMountWorkspace.layer({ root })),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const setUp = Effect.gen(function* () {
  const workspace = yield* Workspace;
  yield* workspace.git(["init", "--quiet", `--initial-branch=${defaultTrunk}`]);
  yield* workspace.write("src/health.ts", "export const ok = true\n");
  yield* workspace.git(["add", "."]);
  yield* workspace.git([
    "-c",
    "user.name=Kojo",
    "-c",
    "user.email=kojo@example.invalid",
    "commit",
    "--quiet",
    "--message",
    "seed",
  ]);
});

describe("the bind-mount workspace", () => {
  it.effect("answers the same check the in-memory adapter answers", () =>
    worktree(treeIsHealthy).pipe(Effect.map((report) => expect(report).toEqual(healthy))),
  );

  it.effect("names the host path, because there is one", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        expect(workspace.hostPath).toEqual(Option.some(workspace.root));
      }),
    ),
  );

  it.effect("sees the tree it was told to grade", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        yield* workspace.write("src/health.ts", "export const ok = false\n");

        // The same check, on the same port, over a tree that really changed on a disk.
        const report = yield* treeIsHealthy;
        expect(report.declaresOk).toBe(false);
        expect(report.clean).toBe(false);
      }),
    ),
  );

  it.effect("hands back a non-zero exit code instead of failing", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const result = yield* workspace.git(["rev-parse", "--verify", "refs/heads/nothing"]);

        expect(result.succeeded).toBe(false);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).not.toBe("");
      }),
    ),
  );

  it.effect("fails only when the command never ran", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const outcome = yield* workspace
          .exec(["kojo-does-not-exist"])
          .pipe(Effect.result, Effect.map(Result.isFailure));

        expect(outcome).toBe(true);
      }),
    ),
  );

  it.effect("refuses a path that leaves the root", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;

        for (const outside of ["../secrets.txt", "src/../../secrets.txt", "/etc/passwd"]) {
          const outcome = yield* workspace.read(outside).pipe(Effect.result);
          expect(Result.isFailure(outcome)).toBe(true);
        }
      }),
    ),
  );

  it.effect("reports an absent path as absent rather than as a fault", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        expect(Option.isNone(yield* workspace.stat("src/nothing.ts"))).toBe(true);

        const directory = yield* workspace.stat("src");
        expect(Option.isSome(directory) && directory.value.kind).toBe("directory");
      }),
    ),
  );
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
