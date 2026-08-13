// `@effect/platform-bun` is imported below by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  type Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  type PlatformError,
  Result,
} from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { created } from "../../../../../src/cli/factory.ts";
import * as SqliteDatabase from "../../../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import * as SingleNodeEngine from "../../../../../src/contexts/workflow/adapters/SingleNodeEngine.ts";

const holder = new URL("../../../../support/holdWriteLock.ts", import.meta.url).pathname;
const rollbackHolder = new URL("../../../../support/holdRollbackLock.ts", import.meta.url).pathname;
const firstRunHolder = new URL("../../../../support/holdFirstRunLock.ts", import.meta.url).pathname;
const coldStart = new URL("../../../../support/coldStart.ts", import.meta.url).pathname;

/** A fresh file per test. WAL and the busy timeout are set when the client opens it. */
const onOwnFile = <A, E>(
  options: { readonly busyTimeout?: Duration.Input | undefined },
  use: (paths: {
    readonly database: string;
    readonly marker: string;
  }) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-database-" });
    return yield* use({ database: `${root}/kojo.db`, marker: `${root}/held` }).pipe(
      Effect.provide(
        Layer.orDie(
          SqliteDatabase.layer({ path: `${root}/kojo.db`, busyTimeout: options.busyTimeout }),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/**
 * Another process holding the file's write lock, released when the scope closes.
 *
 * `process.execPath` is the runner's own Bun, which is also what avoids depending on whatever
 * `bun` resolves to on the machine running the suite.
 */
const holdingWriteLock = (
  paths: { readonly database: string; readonly marker: string },
  millis: number,
) =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [holder, paths.database, paths.marker, String(millis)], {
          stdio: "ignore",
        }),
      ),
      (child) => Effect.sync(() => void child.kill()),
    );

    // The marker is written after the insert, so seeing it means the lock is taken rather than
    // merely asked for.
    yield* untilExists(paths.marker);
  });

/**
 * The same, on a file that is still on its rollback journal — so the next client to open it has to
 * change the journal mode, and cannot until this process lets go.
 */
const holdingRollbackLock = (
  paths: { readonly database: string; readonly marker: string },
  millis: number,
) =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [rollbackHolder, paths.database, paths.marker, String(millis)], {
          stdio: "ignore",
        }),
      ),
      (child) => Effect.sync(() => void child.kill()),
    );
    yield* untilExists(paths.marker);
  });

const untilExists = (marker: string): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.sync(() => existsSync(marker)),
    (found) =>
      found ? Effect.void : Effect.andThen(Effect.sleep("10 millis"), untilExists(marker)),
  );

const insertProbe = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`insert into held (note) values ('probe')`,
);

const isLockTimeout = (error: SqlError.SqlError) => error.reason._tag === "LockTimeoutError";

describe("the shared database client", () => {
  it.live("sets the busy timeout the driver leaves at zero", () =>
    onOwnFile({ busyTimeout: "3 seconds" }, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ readonly timeout: number }>("PRAGMA busy_timeout");
        expect(rows[0]?.timeout).toBe(3000);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("waits for another process's write lock instead of failing on the spot", () =>
    onOwnFile({ busyTimeout: "5 seconds" }, (paths) =>
      Effect.gen(function* () {
        yield* holdingWriteLock(paths, 400);

        const before = yield* Clock.currentTimeMillis;
        yield* insertProbe;
        const waited = (yield* Clock.currentTimeMillis) - before;

        // The write went through, and it went through by waiting. Without the pragma this line is
        // an instant lock error, which is what makes `kojo watch` and `kojo run` starting together
        // a coin flip.
        expect(waited).toBeGreaterThan(150);
      }).pipe(Effect.scoped),
    ).pipe(Effect.orDie),
  );

  it.live("retries the writer that lost the file, and nothing else", () =>
    onOwnFile({ busyTimeout: 0 }, (paths) =>
      Effect.gen(function* () {
        yield* holdingWriteLock(paths, 400);

        // Zero timeout is the driver's own behaviour: the second writer does not wait at all.
        const rejected = yield* Effect.result(insertProbe);
        expect(Result.isFailure(rejected) && isLockTimeout(rejected.failure)).toBe(true);

        yield* SqliteDatabase.retryOnLock(insertProbe);

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly note: string }>`select note from held order by id`;
        expect(rows.map((row) => row.note)).toEqual(["holder", "probe"]);
      }).pipe(Effect.scoped),
    ).pipe(Effect.orDie),
  );

  it.live("leaves a syntax error alone rather than asking it eight more times", () =>
    onOwnFile({}, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const outcome = yield* Effect.result(
          SqliteDatabase.retryOnLock(sql.unsafe("select * from nothing_here")),
        );
        expect(Result.isFailure(outcome) && isLockTimeout(outcome.failure)).toBe(false);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("opens a file another process has locked, instead of dying on the WAL pragma", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-database-open-" });
      const database = `${root}/kojo.db`;
      const marker = `${root}/held`;

      // The lock is taken **before** the client is built, which is the whole difference from the
      // tests above: they open first and contend afterwards. And it is taken on a file that is not
      // in WAL yet, so the client that opens next has to change the journal mode to get there.
      yield* holdingRollbackLock({ database, marker }, 400);

      // Left as a defect on purpose. The driver asks for WAL with a bare `db.run` and does not
      // catch what it throws, so before the fix this line is not a failed effect that something
      // could retry — it is `SQLiteError: database is locked` killing the whole command. Nothing
      // downstream of a died layer can report anything, which is why `orDie` here is honest: if it
      // dies, the test dies with it.
      const rows = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly note: string }>`select note from held order by id`,
      ).pipe(Effect.provide(Layer.orDie(SqliteDatabase.layer({ path: database }))));

      // It waited for the holder rather than dying on it, and then read what the holder committed.
      expect(rows.map((row) => row.note)).toEqual(["holder"]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.orDie),
  );

  it.live("holds the engine's schema and Kojo's own in one file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-database-" });

      // One client, provided once, under both. Two calls to the database layer would be two
      // `bun:sqlite` handles with two independent write serializers on one path.
      const database = SqliteDatabase.layer({ path: `${root}/kojo.db` });
      const both = Layer.mergeAll(
        SingleNodeEngine.layer(),
        SqliteDatabase.migrated({
          "0001_probe": Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`create table kojo_probe (id integer primary key)`,
          ),
        }),
      ).pipe(Layer.provideMerge(database), Layer.orDie);

      const tables = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{
            readonly name: string;
          }>`select name from sqlite_master where type = 'table' order by name`,
      ).pipe(Effect.provide(both));

      const names = tables.map((table) => table.name);
      expect(names).toContain("cluster_messages");
      // The cluster names its own ledger, which overrides the package default. Kojo's has to be
      // named too, or it inherits whichever name was configured last.
      expect(names).toContain("cluster_migrations");
      expect(names).toContain(SqliteDatabase.migrationsTable);
      expect(names).toContain("kojo_probe");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.orDie),
  );
});

/**
 * A temporary directory and the two paths every first-run test needs.
 *
 * No client, unlike `onOwnFile` above — and that is the point of the whole guard. Building a client
 * would create the file, and what these tests are about is the moment before there is one.
 */
const onAbsentFile = <A, E>(
  use: (paths: {
    readonly database: string;
    readonly marker: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-first-run-" });
    return yield* use({ database: `${root}/kojo.db`, marker: `${root}/held` });
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/**
 * Another process holding the first-run lock, and watching the directory while it holds it.
 *
 * With `readies`, it also finishes a first run of its own before letting go — the database and the
 * mark, in that order — so whoever was waiting wakes to a file that is already ready.
 */
const holdingFirstRunLock = (
  paths: { readonly database: string; readonly marker: string },
  millis: number,
  options?: { readonly readies?: boolean | undefined },
) =>
  Effect.gen(function* () {
    const argv = [firstRunHolder, paths.database, paths.marker, String(millis)];
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, options?.readies === true ? [...argv, "ready"] : argv, {
          stdio: "ignore",
        }),
      ),
      (child) => Effect.sync(() => void child.kill()),
    );
    yield* untilExists(paths.marker);
  });

/** The names of every table in the file, read through a client of its own. */
const tablesOf = (database: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly name: string }>`select name from sqlite_master where type = 'table'`,
  ).pipe(
    Effect.map((rows) => rows.map((row) => row.name)),
    Effect.provide(Layer.orDie(SqliteDatabase.layer({ path: database }))),
    Effect.orDie,
  );

/** Everything a command expects to find, from all three writers of the file. */
const expectComplete = (names: ReadonlyArray<string>) => {
  expect(names).toContain("cluster_messages");
  expect(names).toContain("cluster_migrations");
  expect(names).toContain(SqliteDatabase.migrationsTable);
  expect(names).toContain("kojo_runs");
  expect(names).toContain("kojo_asked_gates");
};

/** One cold start in a process of its own, exactly as `coldStart.ts` performs it. */
const spawnColdStart = (database: string): Effect.Effect<number> =>
  Effect.callback<number>((resume) => {
    const child = spawn(process.execPath, [coldStart, database], { stdio: "ignore" });
    child.on("exit", (code) => resume(Effect.succeed(code ?? -1)));
  });

describe("the first run against a factory's database", () => {
  /**
   * The hazard, on purpose and by hand.
   *
   * Not a test of the fix — a test of what the fix exists because of. The file is already there and
   * already in WAL, so the only thing left to contend for is the migration, and the migration is
   * the cluster's. It loses, and what arrives is a **defect**: outside every error channel, past
   * `Effect.result`, uncatchable and unretryable by anything Kojo can write. That is why the answer
   * had to be to keep two processes out of the window rather than to retry what happens inside it.
   */
  it.live("dies rather than fails when the cluster's migrator loses the lock", () =>
    onAbsentFile((paths) =>
      Effect.gen(function* () {
        yield* holdingWriteLock(paths, 4000);

        const exit = yield* Effect.exit(
          Effect.void.pipe(
            Effect.provide(
              SingleNodeEngine.layer().pipe(
                // Zero, so the loss is instant and the test is not a race of its own. The busy
                // timeout is not what saves a cold start anyway: ticket 40 set it, and twelve
                // concurrent cold starts still lost one.
                Layer.provideMerge(SqliteDatabase.layer({ path: paths.database, busyTimeout: 0 })),
              ),
            ),
            Effect.scoped,
          ),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }).pipe(Effect.scoped),
    ).pipe(Effect.orDie),
  );

  /**
   * The fix, with the window forced open rather than hoped for.
   *
   * Another process takes the first-run lock and keeps it for two and a half seconds. Two things
   * are then true, and neither of them is a rate: this process waited for it, and while it waited
   * the database was not created — reported by the holder, from inside the window, because SQLite's
   * busy handler sleeps this thread and a waiting process cannot look at anything.
   */
  it.live("waits for another process's first run, and creates nothing while it waits", () =>
    onAbsentFile((paths) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* holdingFirstRunLock(paths, 2500);

        const before = yield* Clock.currentTimeMillis;
        yield* created(paths.database);
        const waited = (yield* Clock.currentTimeMillis) - before;

        // What the holder saw while it held the lock, and the stronger of the two claims: `database`
        // here would mean a second process creating the file under the first one, which is the
        // fault this ticket is about. Waited for rather than read straight away, so that a build
        // which does not wait is graded by what it did rather than by a file that is not there yet.
        yield* untilExists(`${paths.marker}.sighted`);
        expect(yield* fileSystem.readFileString(`${paths.marker}.sighted`)).toBe("nothing");

        // Migrating the whole file takes about ten milliseconds, so two thousand cannot be anything
        // but the wait.
        expect(waited).toBeGreaterThan(2000);

        expectComplete(yield* tablesOf(paths.database));
      }).pipe(Effect.scoped),
    ).pipe(Effect.orDie),
  );

  /**
   * The ordinary path, graded by a schema that cannot survive being built.
   *
   * A second first run must not migrate, and "must not" is asserted rather than timed: the layer it
   * would build dies on sight. The test passing means it was never built.
   */
  it.live("does nothing at all once the file has been readied", () =>
    onAbsentFile((paths) =>
      Effect.gen(function* () {
        yield* created(paths.database);

        yield* SqliteDatabase.firstRun({
          path: paths.database,
          schema: () => Layer.effectDiscard(Effect.die("the schema was built a second time")),
        });

        expectComplete(yield* tablesOf(paths.database));
      }),
    ).pipe(Effect.orDie),
  );

  /**
   * The loser of the race does nothing, and that is asked again *inside* the lock.
   *
   * The window is forced rather than raced for: another process takes the lock, and while it holds
   * it, makes the database and writes the mark — a whole first run, finished under the lock. This
   * process asks before any of that exists, so its cheap check says no and it queues; by the time it
   * has the lock the file is ready. Only the second `ready` check can see that, and the schema it
   * would otherwise build dies on sight. Passing means the check is there.
   */
  it.live("looks again after it has waited, and builds nothing the winner already built", () =>
    onAbsentFile((paths) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* holdingFirstRunLock(paths, 1500, { readies: true });

        // Nothing is ready yet, so this call cannot take the fast path out — it must queue.
        expect(yield* fileSystem.exists(paths.database)).toBe(false);

        yield* SqliteDatabase.firstRun({
          path: paths.database,
          schema: () => Layer.effectDiscard(Effect.die("the winner's work was built again")),
        });

        // What the winner left, still there and not migrated over.
        expect(yield* tablesOf(paths.database)).toContain("readied_by_the_holder");
      }).pipe(Effect.scoped),
    ).pipe(Effect.orDie),
  );

  /**
   * The other half of "does nothing": it does not queue either.
   *
   * A factory that has started once must keep the concurrency it has, and the lock is the only
   * thing in this change that could take it away. So the lock is held by another process for two
   * and a half seconds while a readied database is asked for — and the answer has to come back at
   * once. A guard that took the lock before it looked would sit here for the whole hold.
   */
  it.live("does not queue behind another process's lock once the file has been readied", () =>
    onAbsentFile((paths) =>
      Effect.gen(function* () {
        yield* created(paths.database);
        yield* holdingFirstRunLock(paths, 2500);

        const before = yield* Clock.currentTimeMillis;
        yield* created(paths.database);
        expect((yield* Clock.currentTimeMillis) - before).toBeLessThan(500);
      }).pipe(Effect.scoped),
    ).pipe(Effect.orDie),
  );

  /**
   * A database that exists but was never readied — `kojo gate list` and `kojo ui` both open the file
   * without migrating it, and a factory older than this guard has no mark at all.
   *
   * Two claims in one: the guard does not step aside for a file that is merely *there*, and it
   * migrates where the file lies. Staging a fresh database and renaming it into place would satisfy
   * the first and lose everything the second protects.
   */
  it.live(
    "migrates a database that was opened before it was readied, and keeps what it holds",
    () =>
      onAbsentFile((paths) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
            Effect.andThen(
              sql`create table earlier (note text)`,
              sql`insert into earlier ${sql.insert({ note: "from before" })}`,
            ),
          ).pipe(Effect.provide(Layer.orDie(SqliteDatabase.layer({ path: paths.database }))));

          expect(yield* fileSystem.exists(SqliteDatabase.readyMarkOf(paths.database))).toBe(false);

          yield* created(paths.database);

          const names = yield* tablesOf(paths.database);
          expectComplete(names);
          expect(names).toContain("earlier");

          const kept = yield* Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql<{ readonly note: string }>`select note from earlier`,
          ).pipe(
            Effect.provide(Layer.orDie(SqliteDatabase.layer({ path: paths.database }))),
            Effect.orDie,
          );
          expect(kept.map((row) => row.note)).toEqual(["from before"]);
        }),
      ).pipe(Effect.orDie),
  );

  /**
   * The ticket's own sentence, run as written: twelve processes, one absent database.
   *
   * **This one is a rate and is reported as one.** It cannot be otherwise — twelve real processes
   * decide their own order — and it is here because it is the acceptance criterion, not because it
   * grades anything the tests above do not. One round of twelve is far too few to catch the fault
   * it guards against, so read it as a smoke test and read the deterministic tests above as the
   * grading.
   *
   * The rate it stands for was measured by hand, forty rounds each way, on one machine, back to
   * back, with the same layers in both: `coldStart.ts` exactly as it is, **480 processes, 0 lost**;
   * the same file with `created` taken out, **480 processes, 10 lost, every one of them a defect**
   * (`SqlError: Failed to execute statement`, raised past every error channel). Losing fewer than
   * all three migrators from the unguarded reproduction dropped the rate to zero, which is why
   * `coldStart.ts` builds the trace, the askings and the cluster together.
   */
  it.live("lets twelve concurrent cold starts through, every one of them", () =>
    onAbsentFile((paths) =>
      Effect.gen(function* () {
        const codes = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, index) => index),
          () => spawnColdStart(paths.database),
          { concurrency: "unbounded" },
        );

        expect(codes).toEqual(Array.from({ length: 12 }, () => 0));
        expectComplete(yield* tablesOf(paths.database));
      }),
    ).pipe(Effect.orDie),
  );
});
