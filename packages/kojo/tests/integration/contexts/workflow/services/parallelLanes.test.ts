// `@effect/platform-bun` by deep path, never its barrel: the barrel re-exports BunRedis and would
// drag a Redis client in behind it.
import { execFileSync } from "node:child_process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, type PlatformError, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { noSandbox } from "../../../../../src/contexts/sandbox/adapters/providers.ts";
import * as SandcastleSandboxSource from "../../../../../src/contexts/sandbox/adapters/SandcastleSandboxSource.ts";
import type { SandboxHooks } from "../../../../../src/contexts/sandbox/models/SandboxHooks.ts";
import { Sandbox } from "../../../../../src/contexts/sandbox/ports/Sandbox.ts";
import type { SandboxSource } from "../../../../../src/contexts/sandbox/ports/SandboxSource.ts";
import * as SqliteDatabase from "../../../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { laneOf } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import * as SqliteTracer from "../../../../../src/contexts/trace/adapters/SqliteTracer.ts";
import type { Tracer } from "../../../../../src/contexts/trace/ports/Tracer.ts";
import { CurrentRun } from "../../../../../src/contexts/workflow/services/CurrentRun.ts";
import { sandboxed } from "../../../../../src/contexts/workflow/services/sandboxed.ts";

/**
 * **Two lanes of one run, both real, at the same time.**
 *
 * The unit tier proves what the scope *does* — where it sits, what it records, when it is released.
 * What it cannot prove is that two of them can be built at once against one repository: two real
 * worktrees, two real branches, two containers, and one host `git` that both of them drive. That is
 * what is measured here.
 *
 * `no-sandbox` rather than Docker, deliberately. The claims are about worktrees, branches, and the
 * environment a provider stamps on a process — all of which `no-sandbox` answers for real, in
 * seconds rather than in minutes, and without a second agent's containers being able to change the
 * answer (see `lane.test.ts`'s environmental note).
 */

const runId = "run-two-lanes" as RunId;
const alphaBranch = "kojo/lane/alpha";
const betaBranch = "kojo/lane/beta";

const git = (repo: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd: repo, encoding: "utf8" });

interface Fixture {
  readonly repo: string;
  readonly database: string;
  /** One sentinel **per lane**, so each lane's hook fires exactly once and both of them fire. */
  readonly armed: (lane: string) => string;
}

/** A repository with one commit on `main`, and the sentinels the rebuild hooks disarm. */
const fixture: Effect.Effect<
  Fixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // `/tmp` rather than `os.tmpdir()`, for the reason recorded at `lane.test.ts`'s `fixtureRoot`.
  const root = yield* fileSystem.makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "kojo-lanes-",
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

  for (const lane of ["alpha", "beta"]) {
    yield* fileSystem.writeFileString(`${root}/armed-${lane}`, "");
  }
  return {
    repo,
    database: `${root}/kojo.db`,
    armed: (lane: string) => `${root}/armed-${lane}`,
  };
});

/**
 * What a lane reports about itself, read from **inside** its own sandbox.
 *
 * `printenv` rather than the handle's `environment` field: the question is whether the correlation
 * crossed the boundary into the process the lane's work runs in, and only the far side can answer
 * that. `git rev-parse` is asked there too, so the branch is the branch the work is standing on
 * rather than the branch Kojo asked for.
 */
const reportFromInside = Effect.gen(function* () {
  const sandbox = yield* Sandbox;
  const key = yield* sandbox.exec("printenv KOJO_PHASE_ID");
  const run = yield* sandbox.exec("printenv KOJO_RUN_ID");
  const head = yield* sandbox.exec("git rev-parse --abbrev-ref HEAD");
  return {
    id: sandbox.id,
    worktreePath: sandbox.worktreePath,
    key: key.stdout.trim(),
    run: run.stdout.trim(),
    head: head.stdout.trim(),
  };
});

/** The hook that takes a workspace away once, so an acquisition has to be thrown away and redone. */
const deleteOnce = (sentinel: string): SandboxHooks => ({
  host: {
    onSandboxReady: [
      { command: `if [ -e ${sentinel} ]; then rm -f ${sentinel}; rm -rf "$PWD"; fi` },
    ],
  },
});

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
          Layer.orDie(SqliteTracer.layer).pipe(
            Layer.provideMerge(Layer.orDie(SqliteDatabase.layer({ path: fixed.database }))),
          ),
          SandcastleSandboxSource.layer,
        ),
      ),
    ),
  ).pipe(Effect.scoped, Effect.provide(BunServices.layer));

interface SandboxRow {
  readonly sandbox_id: string;
  readonly name: string;
  readonly branch: string;
  readonly worktree_path: string;
  readonly outcome: string;
  readonly acquired_at: number;
  readonly released_at: number;
}

const sandboxRows = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql.unsafe<SandboxRow>(`select * from ${SqliteTracer.tables.sandboxes} order by id`),
);

/** Both lanes, entered at once, each reporting on itself from inside its own container. */
const bothLanes = (fixed: Fixture, rebuild = false) =>
  Effect.all(
    [
      sandboxed(
        {
          name: "alpha",
          branch: alphaBranch,
          provider: noSandbox(),
          cwd: fixed.repo,
          ...(rebuild ? { hooks: deleteOnce(fixed.armed("alpha")) } : {}),
        },
        reportFromInside,
      ),
      sandboxed(
        {
          name: "beta",
          branch: betaBranch,
          provider: noSandbox(),
          cwd: fixed.repo,
          ...(rebuild ? { hooks: deleteOnce(fixed.armed("beta")) } : {}),
        },
        reportFromInside,
      ),
    ],
    { concurrency: "unbounded" },
  );

describe("two lanes of one run, built at the same time", () => {
  it.live(
    "gives each one its own worktree, its own branch, and its own correlation",
    () =>
      inFixture((fixed) =>
        Effect.gen(function* () {
          const [alpha, beta] = yield* bothLanes(fixed);

          // Two worktrees, two branches, and each lane standing on its own — asked of git inside
          // the lane rather than of Kojo's own record of what it asked for.
          expect(alpha.head).toBe(alphaBranch);
          expect(beta.head).toBe(betaBranch);
          expect(alpha.worktreePath).not.toBe(beta.worktreePath);

          // The correlation crossed into both processes, and each one carries its **own**
          // acquisition. Nothing downstream has to guess which lane a line of output came from.
          expect(alpha.key).toBe(alpha.id);
          expect(beta.key).toBe(beta.id);
          expect(alpha.key).not.toBe(beta.key);
          expect(alpha.run).toBe(runId);
          expect(beta.run).toBe(runId);

          // And the lane is readable straight off the key, which is what a phase row carries.
          expect(Option.getOrNull(laneOf(alpha.key))).toBe("alpha");
          expect(Option.getOrNull(laneOf(beta.key))).toBe("beta");

          const rows = yield* sandboxRows;
          expect(rows.map((row) => row.name).sort()).toEqual(["alpha", "beta"]);
          expect(rows.map((row) => row.outcome)).toEqual(["released", "released"]);
          expect(new Set(rows.map((row) => row.worktree_path)).size).toBe(2);

          // They were alive at the same moment. Without this the rest is a story about two lanes
          // that politely took turns, and the timestamp reading below would be sound.
          const [first, second] = rows;
          expect(
            (first?.acquired_at ?? 0) <= (second?.released_at ?? 0) &&
              (second?.acquired_at ?? 0) <= (first?.released_at ?? 0),
          ).toBe(true);

          // Both branches exist on the host afterwards. The branch is the durable state, and two
          // lanes leave two of them.
          expect(git(fixed.repo, ["rev-parse", "--abbrev-ref", alphaBranch]).trim()).toBe(
            alphaBranch,
          );
          expect(git(fixed.repo, ["rev-parse", "--abbrev-ref", betaBranch]).trim()).toBe(
            betaBranch,
          );
        }),
      ),
    120000,
  );

  it.live(
    "recovers when both lanes have to rebuild their container at once",
    () =>
      inFixture((fixed) =>
        Effect.gen(function* () {
          // One sentinel per lane, so **both** lanes lose their workspace and both rebuild at the
          // same time. That is the case ticket 37 could not reach on its own: two `git worktree
          // add` calls against one repository, with one `.git` between them.
          const [alpha, beta] = yield* bothLanes(fixed, true);

          expect(alpha.head).toBe(alphaBranch);
          expect(beta.head).toBe(betaBranch);
          expect(alpha.key).toBe(alpha.id);
          expect(beta.key).toBe(beta.id);

          // Four acquisitions for two lanes: one discarded and one working, each way round.
          const rows = yield* sandboxRows;
          expect(rows).toHaveLength(4);
          for (const lane of ["alpha", "beta"]) {
            const mine = rows.filter((row) => row.name === lane);
            expect(mine.map((row) => row.outcome)).toEqual(["failed", "released"]);
            // And the trace says which lane each container belonged to without any joining, even
            // with four of them interleaved.
            expect(mine.map((row) => Option.getOrNull(laneOf(row.sandbox_id)))).toEqual([
              lane,
              lane,
            ]);
          }
        }),
      ),
    120000,
  );
});
