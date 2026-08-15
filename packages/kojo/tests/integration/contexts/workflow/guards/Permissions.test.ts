// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Result } from "effect";
import * as BindMountWorkspace from "../../../../../src/contexts/sandbox/adapters/BindMountWorkspace.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import { defaultTrunk } from "../../../../../src/contexts/shared/models/FactoryLayout.ts";
import * as Permissions from "../../../../../src/contexts/workflow/guards/Permissions.ts";
import { PermissionBreach } from "../../../../../src/contexts/workflow/models/PermissionBreach.ts";
import {
  factoryOwnPaths,
  type PermissionPolicy,
} from "../../../../../src/contexts/workflow/models/PermissionPolicy.ts";

/**
 * The guard against real git, in a real worktree on a real disk.
 *
 * The unit tier proves the rules; this proves the two commands the rules stand on — that
 * `git diff HEAD --numstat` and `git ls-files --others` really do report what the guard reads them
 * as, and that the undo really does put the tree back. Everything goes through the `Workspace`
 * port, which is what will make the same guard honest inside a container.
 */
const worktree = <A, E>(use: Effect.Effect<A, E, Workspace>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-permissions-" });
    return yield* setUp.pipe(
      Effect.andThen(use),
      Effect.provide(BindMountWorkspace.layer({ root })),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const setUp = Effect.gen(function* () {
  const workspace = yield* Workspace;
  yield* workspace.git(["init", "--quiet", `--initial-branch=${defaultTrunk}`]);
  yield* workspace.write("src/health.ts", "export const ok = true\n");
  yield* workspace.write(".kojo/checks.ts", "export const checks = []\n");
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

const builder: PermissionPolicy = {
  agent: "hotfixer",
  writes: { _tag: "Unrestricted" },
  protectedPaths: factoryOwnPaths,
  alwaysWritable: [".kojo/data/"],
};

const breachIn = <A, E>(outcome: Result.Result<A, E>): PermissionBreach => {
  const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
  if (failure instanceof PermissionBreach) return failure;
  throw new Error(`expected a permission breach, got ${JSON.stringify(outcome)}`);
};

describe("the permission guard over a real worktree", () => {
  it.effect("fingerprints a clean tree as holding nothing", () =>
    worktree(
      Effect.gen(function* () {
        expect([...(yield* Permissions.snapshot)]).toEqual([]);
      }),
    ),
  );

  it.effect("sees an edit, an addition, and a reversion alike", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const before = yield* Permissions.snapshot;

        yield* workspace.write("src/health.ts", "export const ok = false\n");
        yield* workspace.write("notes.md", "found it\n");

        const after = yield* Permissions.snapshot;
        expect(Permissions.changedPaths(before, after)).toEqual(["notes.md", "src/health.ts"]);
      }),
    ),
  );

  it.effect("deletes a factory file the agent created, and keeps the work it was allowed", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const before = yield* Permissions.snapshot;

        yield* workspace.write("src/health.ts", "export const ok = false\n");
        // An agent editing its own grader is the case the whole guard exists for.
        yield* workspace.write(".kojo/workflows/grader.ts", "export const pass = true\n");

        const breach = breachIn(yield* Permissions.enforce(builder, before).pipe(Effect.result));
        expect(breach.paths.map((rollback) => [rollback.path, rollback.outcome._tag])).toEqual([
          [".kojo/workflows/grader.ts", "Deleted"],
        ]);

        expect(Option.isNone(yield* workspace.stat(".kojo/workflows/grader.ts"))).toBe(true);
        expect(yield* workspace.read("src/health.ts")).toBe("export const ok = false\n");
      }),
    ),
  );

  it.effect("restores a tracked factory file the agent rewrote", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const before = yield* Permissions.snapshot;

        yield* workspace.write(".kojo/checks.ts", "export const checks = null\n");

        const breach = breachIn(yield* Permissions.enforce(builder, before).pipe(Effect.result));
        expect(breach.paths[0]?.outcome).toEqual({ _tag: "Restored" });
        expect(yield* workspace.read(".kojo/checks.ts")).toBe("export const checks = []\n");
      }),
    ),
  );

  it.effect("removes a factory file the agent created and then staged", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const before = yield* Permissions.snapshot;

        yield* workspace.write(".kojo/commands.ts", "export const test = 'true'\n");
        // Staged, so `git diff HEAD` reports it as tracked and `HEAD` has nothing to restore from.
        yield* workspace.git(["add", ".kojo/commands.ts"]);

        const breach = breachIn(yield* Permissions.enforce(builder, before).pipe(Effect.result));
        expect(breach.paths[0]?.outcome).toEqual({ _tag: "Deleted" });
        expect(Option.isNone(yield* workspace.stat(".kojo/commands.ts"))).toBe(true);
      }),
    ),
  );

  it.effect("undoes a change the agent staged over a tracked factory file", () =>
    worktree(
      Effect.gen(function* () {
        const workspace = yield* Workspace;
        const before = yield* Permissions.snapshot;

        yield* workspace.write(".kojo/checks.ts", "export const checks = null\n");
        // `git checkout -- <path>` restores from the index, so a staged change would survive it.
        // The undo reads `HEAD` for exactly this case.
        yield* workspace.git(["add", ".kojo/checks.ts"]);

        yield* Permissions.enforce(builder, before).pipe(Effect.result);
        expect(yield* workspace.read(".kojo/checks.ts")).toBe("export const checks = []\n");
      }),
    ),
  );
});
