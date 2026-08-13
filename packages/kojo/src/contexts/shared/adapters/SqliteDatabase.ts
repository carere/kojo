import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import {
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  type PlatformError,
  Schedule,
} from "effect";
import { Migrator, SqlClient, SqlError } from "effect/unstable/sql";

/**
 * How long a writer waits for another writer before it gives up.
 *
 * The driver sets no busy timeout at all, so a second writer fails *instantly* with a lock error.
 * Kojo runs at least two writers on one file by design — a run and the process watching it — so
 * without this, starting both together is a coin flip.
 */
const defaultBusyTimeout = Duration.seconds(5);

/**
 * Kojo's migration ledger.
 *
 * Named rather than inherited, and that is deliberate twice over. The package default is
 * `effect_sql_migrations`, a name Kojo does not own; and the cluster overrides that default with
 * `cluster_migrations` for its own schema, so an unnamed Kojo migrator would write its ledger into
 * whatever the last configuration decided.
 */
export const migrationsTable = "kojo_migrations";

/**
 * Sets the busy timeout on the connection the client just opened.
 *
 * It is a separate layer above the client rather than an option on it, because the driver has no
 * option for it: the only pragma it issues is `journal_mode = WAL`.
 */
const busyTimeout = (millis: number): Layer.Layer<never, SqlError.SqlError, SqlClient.SqlClient> =>
  Layer.effectDiscard(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe<{ readonly timeout: number }>(`PRAGMA busy_timeout = ${millis}`),
    ),
  );

/** A writer that lost the file to another writer, rather than a query that is wrong. */
const isLockContention = (error: unknown): boolean =>
  error instanceof SqlError.SqlError && error.reason._tag === "LockTimeoutError";

/**
 * Retries a statement that lost the write lock, and only that.
 *
 * The busy timeout covers contention the driver can wait out on the connection; this covers what is
 * left, which is a writer that waited its whole timeout and still lost. Nothing else is retried: a
 * constraint violation or a syntax error is the same error however many times it is asked.
 */
export const retryOnLock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    while: (error: E) => isLockContention(error),
    schedule: Schedule.exponential(Duration.millis(20), 2),
    times: 8,
  });

/**
 * Turns WAL on **after** the busy timeout is set, rather than letting the driver do it at open.
 *
 * The driver asks for `PRAGMA journal_mode = WAL` with a bare `db.run`, on a connection that has no
 * busy handler yet, and it does not catch what that throws. Ask it of a file another process is
 * writing at that moment and the answer is `SQLiteError: database is locked` — raised
 * synchronously, outside the client's own error classification, so it arrives as a **defect**
 * rather than as a `SqlError` anything could wait out or retry. That is `kojo watch` and `kojo run`
 * started together, one of them dying on the first thing it touches.
 *
 * So the driver is told not to (`disableWAL`), the timeout is set first, and the pragma is asked
 * here — where it waits like every other statement, and where losing anyway is a typed lock error
 * `retryOnLock` asks again. Nothing about the file changes: a database Kojo opened is still a WAL
 * database.
 */
const writeAheadLog: Layer.Layer<never, SqlError.SqlError, SqlClient.SqlClient> =
  Layer.effectDiscard(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      retryOnLock(sql.unsafe<{ readonly journal_mode: string }>("PRAGMA journal_mode = WAL")),
    ),
  );

/**
 * The one database client, on one file.
 *
 * **Build this once and provide it to everything.** The `SqlClient` tag is a single service, so two
 * layers for the same path do not resolve to one client: they are two `bun:sqlite` handles with two
 * independent write serializers, and the driver's own serialization does not span them. The engine's
 * persistence and the trace are two schemas that share one file, which means they share this value —
 * `Layer.mergeAll(engine, tracer).pipe(Layer.provideMerge(database))`, never one call each.
 *
 * The three layers are ordered rather than merged: the connection, then the busy timeout, then WAL.
 * See `writeAheadLog` for what the driver's own ordering costs. The first writer is still what
 * creates the file.
 */
export const layer = (options: {
  readonly path: string;
  readonly busyTimeout?: Duration.Input | undefined;
}): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, SqlError.SqlError> =>
  writeAheadLog.pipe(
    Layer.provideMerge(
      busyTimeout(
        Math.trunc(
          Duration.toMillis(Duration.fromInputUnsafe(options.busyTimeout ?? defaultBusyTimeout)),
        ),
      ),
    ),
    Layer.provideMerge(SqliteClient.layer({ filename: options.path, disableWAL: true })),
  );

/**
 * Runs Kojo's own migrations against the shared client, under Kojo's own ledger.
 *
 * Migrating is racy on purpose-built-for-one-process code: the ledger row is inserted *before* its
 * body runs, and a conflict there is swallowed as a debug log that reports no migrations. Two
 * processes starting together can therefore leave one of them running against a database it never
 * verified. A migration that fails is `Effect.die`, not a typed error, so there is nothing to catch
 * inside it either.
 *
 * **So the whole migration is asked again, not the statement that lost.** The migrator reads its
 * ledger and then writes, in one transaction, and SQLite refuses that upgrade *immediately* when
 * another connection has written since the read began — a busy timeout cannot help, because waiting
 * for a snapshot that is already stale would deadlock. What answers it is starting the transaction
 * over, which is what wrapping the build rather than the statement does. Every attempt is a fresh
 * layer, so the second one reads the ledger the first one lost the race to.
 */
export const migrated = (
  migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>,
): Layer.Layer<never, SqlError.SqlError | Migrator.MigrationError, SqlClient.SqlClient> =>
  Layer.effectDiscard(
    retryOnLock(
      Effect.provide(
        Effect.void,
        SqliteMigrator.layer({ loader: Migrator.fromRecord(migrations), table: migrationsTable }),
      ),
    ),
  );

/**
 * How long one process waits for another process's first run before it gives up and says so.
 *
 * Generous, because what it waits for is every migration in the file running once, and mean, because
 * the alternative to a bound is a command that hangs. Losing the wait is a typed `SqlError` the
 * caller may ask again — never a defect.
 */
const firstRunPatience = Duration.seconds(30);

/** The mutex two first runs contend for. A SQLite file of its own, with no schema and no migrator. */
export const lockOf = (database: string): string => `${database}.first-run`;

/** Written last, and therefore the only honest answer to *is this file ready*. */
export const readyMarkOf = (database: string): string => `${database}.migrated`;

/**
 * The mutex, and why it is a SQLite transaction rather than an exclusively-created file.
 *
 * `BEGIN EXCLUSIVE` takes a POSIX advisory lock on the file, and the **kernel drops that lock when
 * the holder dies**. That is the whole reason for the choice. `FileRunLock` takes its claims with
 * `O_EXCL` and refuses to break a stale one on purpose — a claim outlives its process and only a
 * human can say whether the holder is gone. Here the opposite is true: a first run that was killed
 * mid-migration must not leave a repository unable to start a factory ever again, and a lock the
 * operating system releases is the liveness test that `O_EXCL` plus a heuristic would only pretend
 * to be.
 *
 * The lock has a file of its own, beside the database and never inside it. Locking *in* the
 * database is what this whole guard exists to avoid: the ledger race the cluster's migrator turns
 * into a defect happens in exactly the file being migrated. This file holds no schema, so it has no
 * migrator, so nothing here can lose a ledger race.
 */
const underFirstRunLock = <A, E>(
  database: string,
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E | SqlError.SqlError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.acquireUseRelease(
      sql.unsafe("begin exclusive"),
      () => effect,
      // The transaction wrote nothing, so what a commit does here is let go. It cannot be allowed
      // to fail the caller: the work is already done, and a run refused because its lock would not
      // release would be a lie about the database.
      () => Effect.orDie(sql.unsafe("commit")),
    );
  }).pipe(
    Effect.provide(
      busyTimeout(Math.trunc(Duration.toMillis(firstRunPatience))).pipe(
        // No WAL on the lock file. It is never read and never written — only locked — so a journal
        // mode costs it two sidecar files and buys it nothing.
        Layer.provideMerge(SqliteClient.layer({ filename: lockOf(database), disableWAL: true })),
      ),
    ),
  );

/**
 * Creates and migrates the file once, alone, before anything can race for it.
 *
 * **This is a guard against an upstream defect, not against Kojo's own code.** The cluster's
 * migrator wraps itself in `Effect.orDie`, so a lock it loses arrives as a **defect** — outside
 * every error channel, uncatchable, unretryable. Ticket 40 fixed both hazards Kojo owns and
 * measured what was left: twelve concurrent starts against a file that does not exist yet still
 * lost one, and twelve against a file that already exists lost none. The asymmetry is the whole
 * story. A database that exists is already in WAL, where readers never block and writers wait their
 * busy timeout; a database that does not exist is created, converted to WAL and migrated by
 * whichever process got there first, while the others read and write across the change.
 *
 * So the fix is not to retry the defect — nothing can. It is to make sure the window never has two
 * processes in it. The first command to touch a factory's database takes the lock, builds every
 * schema in the file while it is the only writer, and writes a mark; every other process waits for
 * the lock and then finds the mark and does nothing.
 *
 * **The mark is a file beside the database, and it is not the database.** "The file is there" is
 * not the same question as "the file is ready": `kojo gate list` and `kojo ui` open the database
 * without migrating it, and either of them can leave an empty or half-built file behind. A guard
 * that trusted the database's own existence would step aside for exactly that file and hand the
 * race straight back. The mark is written after the last migration and is therefore true when it
 * exists.
 *
 * **The schema is built in place, never over the top of an existing file.** A database with a mark
 * missing may be an empty one `kojo ui` made a moment ago, or it may be a factory's whole history
 * from before this guard existed. Migrating where it lies is right for both; staging a fresh file
 * and renaming it into place would be right for the first and would destroy the second.
 *
 * **The ordinary path is two `stat` calls.** A factory whose database is ready takes no lock, opens
 * nothing, and keeps exactly the concurrency it has today.
 */
export const firstRun = <A, E>(options: {
  /** The database every command shares. */
  readonly path: string;
  /**
   * Every schema the file holds, over a client of its own on the path it is given.
   *
   * It asks for nothing from the context on purpose. A schema that took its client from outside
   * would be migrated through whatever client the caller happened to have open — and the one thing
   * this function must control is which handle does the migrating.
   */
  readonly schema: (path: string) => Layer.Layer<A, E>;
}): Effect.Effect<
  void,
  E | SqlError.SqlError | PlatformError.PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    if (yield* ready(options.path)) return;

    yield* underFirstRunLock(
      options.path,
      Effect.gen(function* () {
        // Asked again, and the second asking is the point of the lock: whoever we waited for has
        // finished, and if they built the schema then there is nothing left to build.
        if (yield* ready(options.path)) return;

        yield* Effect.provide(Effect.void, options.schema(options.path));

        const fileSystem = yield* FileSystem.FileSystem;
        const now = yield* DateTime.now;
        yield* fileSystem.writeFileString(
          readyMarkOf(options.path),
          `kojo created and migrated ${options.path} at ${DateTime.formatIso(now)}\n`,
        );
      }),
    );
  });

/**
 * Whether the database is there **and** was migrated by a first run.
 *
 * Both, because either alone is a lie. A mark with no database is a file somebody deleted, and
 * skipping on it would put twelve processes back on one absent file. A database with no mark is one
 * that was opened before it was readied.
 */
const ready = (
  database: string,
): Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(readyMarkOf(database)))) return false;
    return yield* fileSystem.exists(database);
  });
