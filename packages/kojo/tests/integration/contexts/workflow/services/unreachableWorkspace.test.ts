// `@effect/platform-bun` by deep path, never its barrel: the barrel re-exports BunRedis and would
// drag a Redis client in behind it.
import { execFileSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  type Scope,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import * as SandcastleSandboxSource from "../../../../../src/contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import type { SandboxHooks } from "../../../../../src/contexts/sandbox/models/SandboxHooks.ts";
import { WorkspaceUnreachable } from "../../../../../src/contexts/sandbox/models/WorkspaceUnreachable.ts";
import type { SandboxSource } from "../../../../../src/contexts/sandbox/ports/SandboxSource.ts";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import * as SqliteDatabase from "../../../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import * as SqliteTracer from "../../../../../src/contexts/trace/adapters/SqliteTracer.ts";
import type { Tracer } from "../../../../../src/contexts/trace/ports/Tracer.ts";
import { CurrentRun } from "../../../../../src/contexts/workflow/services/CurrentRun.ts";
import { sandboxed } from "../../../../../src/contexts/workflow/services/sandboxed.ts";

/**
 * **architecture.md §8, edge 11, made to happen on demand.**
 *
 * The fault ticket 19 found is a container that starts and then cannot resolve its own working
 * directory. In the wild it arrives as a *rate*: Sandcastle reuses one host path per branch, a
 * rebuild after a gate deletes that directory and creates it again, and the macOS Docker VM
 * sometimes does not follow. A fix graded by a rate is not graded, so the fault is produced here
 * rather than waited for.
 *
 * **How, and what that buys.** `hooks.host.onSandboxReady` is a host command Sandcastle runs *after*
 * the sandbox is up and before Kojo touches it — the exact window the fault lives in. The hook
 * deletes the worktree, so the next command in that workspace dies. Everything under it is real:
 * real Sandcastle, a real worktree, a real branch, real git, the real trace on a real SQLite file.
 *
 * **What it is not.** It is not the Docker VM's stale-mount race. It produces the same *state* — a
 * live sandbox whose workspace cannot be entered — by the shortest deterministic route, and on
 * `no-sandbox`, where the operating system answers instead of a virtual machine's cache. Measured on
 * this machine: `no-sandbox` fails **8 of 8** that way, and the same deletion under Docker fails 18
 * of 18 *only* once the container has already run a command, and 1 of 8 when it has not. That is why
 * the provider here is the deterministic one, and why the Docker wording — exit 127 and the OCI
 * sentence — is pinned separately, as a string, in
 * `tests/unit/contexts/sandbox/guards/workspaceIsReachable.test.ts`.
 */

const runId = "run-edge-eleven" as RunId;
const branch = "kojo/unreachable";

const git = (repo: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: repo, encoding: "utf8" });

interface Fixture {
  readonly repo: string;
  readonly database: string;
  readonly armed: string;
}

/** A repository with one commit on `main`, and the file the surviving container has to read back. */
const fixture: Effect.Effect<
  Fixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // `/tmp` rather than `os.tmpdir()`, for the reason `lane.test.ts` gives at `fixtureRoot`: on macOS
  // `$TMPDIR` is where the rebuild fault is worst, and a fixture that tripped it by accident would
  // make this suite flaky about the very thing it is pinning.
  const root = yield* fileSystem.makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "kojo-edge11-",
  });
  const repo = `${root}/repo`;

  yield* fileSystem.makeDirectory(`${repo}/src`, { recursive: true });
  yield* fileSystem.writeFileString(`${repo}/src/health.ts`, "export const ok = true\n");
  yield* Effect.sync(() => {
    git(repo, ["init", "--quiet", "--initial-branch=main"]);
    git(repo, ["config", "user.name", "Kojo"]);
    git(repo, ["config", "user.email", "kojo@example.invalid"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "--message", "seed"]);
  });

  // The sentinel exists from the start, so a hook that reads it fires exactly once. Written here
  // rather than in the test that uses it, so a test cannot forget it and pass by building one
  // healthy container — which is what the first draft of this file did.
  const armed = `${root}/armed`;
  yield* fileSystem.writeFileString(armed, "");

  return { repo, database: `${root}/kojo.db`, armed };
});

/**
 * The hook that takes the workspace away, and the sentinel that decides how often.
 *
 * With `armed` present the hook fires once and disarms itself, which is a transient fault and the
 * case a rebuild is supposed to survive. With no sentinel it fires on every acquisition, which is
 * the case no rebuild can survive. One mechanism, two stories, and the difference is one file.
 */
const deleteTheWorkspace = (sentinel?: string): SandboxHooks => ({
  host: {
    onSandboxReady: [
      {
        command:
          sentinel === undefined
            ? 'rm -rf "$PWD"'
            : `if [ -e ${sentinel} ]; then rm -f ${sentinel}; rm -rf "$PWD"; fi`,
      },
    ],
  },
});

/** What the tree the run ended up working in says. The proof that a usable container arrived. */
const readHealth = Effect.flatMap(Workspace, (workspace) => workspace.read("src/health.ts"));

const inFixture = <A, E>(
  use: (
    fixed: Fixture,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | SandboxSource | Tracer | CurrentRun>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.flatMap(fixture, (fixed) =>
    use(fixed).pipe(
      Effect.provideService(CurrentRun, { runId }),
      Effect.provide(
        Layer.mergeAll(
          // The real writer on a real file, per the testing rule — no in-memory tracer appears
          // here, and no in-memory sandbox source either.
          Layer.orDie(SqliteTracer.layer).pipe(
            Layer.provideMerge(Layer.orDie(SqliteDatabase.layer({ path: fixed.database }))),
          ),
          SandcastleSandboxSource.layer,
        ),
      ),
    ),
  ).pipe(Effect.scoped, Effect.provide(BunServices.layer));

interface SandboxRow {
  readonly worktree_path: string;
  readonly outcome: string;
  readonly sandbox_id: string;
}

const sandboxRows = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql.unsafe<SandboxRow>(`select * from ${SqliteTracer.tables.sandboxes} order by id`),
);

describe("a sandbox whose workspace is gone before the first command", () => {
  it.live(
    "throws that container away and builds another one, rather than failing the run",
    () =>
      inFixture((fixed) =>
        Effect.gen(function* () {
          const health = yield* sandboxed(
            {
              name: "lane",
              branch,
              provider: noSandbox(),
              cwd: fixed.repo,
              hooks: deleteTheWorkspace(fixed.armed),
            },
            readHealth,
          );

          // The region ran, on the second container, and read the branch's own file. Nothing about
          // the run was wrong, so nothing about the run stopped.
          expect(health).toBe("export const ok = true\n");

          // Two rows: the container that was thrown away, and the one that worked. The discarded
          // one is `failed` — the same word an acquisition gets when the worktree check rejects it,
          // because it is the same fact — and it is **there**, which is what makes the cost of the
          // recovery visible instead of invisible.
          const rows = yield* sandboxRows;
          expect(rows.map((row) => row.outcome)).toEqual(["failed", "released"]);
          expect(new Set(rows.map((row) => row.sandbox_id)).size).toBe(2);

          // Sandcastle derives the worktree path from the repo and the branch, so both acquisitions
          // used the **same host path**. That reuse is the mechanism of edge 11, asserted rather
          // than described: if it ever stops being true, this line says so.
          expect(new Set(rows.map((row) => row.worktree_path)).size).toBe(1);

          // And the branch is still there, with its worktree rebuilt under it.
          expect(git(fixed.repo, ["rev-parse", "--abbrev-ref", branch]).trim()).toBe(branch);
        }),
      ),
    120000,
  );

  it.live(
    "gives up after three containers, naming the workspace and the branch",
    () =>
      inFixture((fixed) =>
        Effect.gen(function* () {
          const exit = yield* sandboxed(
            {
              name: "lane",
              branch,
              provider: noSandbox(),
              cwd: fixed.repo,
              hooks: deleteTheWorkspace(),
            },
            readHealth,
          ).pipe(Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          const failure = Option.getOrThrow(
            Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none(),
          );

          // Not a `SandboxError` about `git rev-parse`, which is what a run would fail with if the
          // worktree were graded before the workspace were probed — the host cannot read a tree
          // that is not there either. The order of the two checks inside `sandboxed` is what makes
          // this assertion the one that holds.
          expect(failure).toBeInstanceOf(WorkspaceUnreachable);
          const unreachable = failure as WorkspaceUnreachable;
          expect(unreachable.branch).toBe(branch);
          expect(unreachable.worktreePath).toContain(".sandcastle/worktrees/kojo-unreachable");
          expect(unreachable.containers).toBe(3);
          expect(unreachable.reach.reached).toBe(false);
          expect(unreachable.summary).toContain(unreachable.worktreePath);
          expect(unreachable.summary).toContain(branch);

          // Three containers, three rows, bounded — a run that kept rebuilding would be worse than
          // a run that stops.
          const rows = yield* sandboxRows;
          expect(rows.map((row) => row.outcome)).toEqual(["failed", "failed", "failed"]);
        }),
      ),
    120000,
  );
});
