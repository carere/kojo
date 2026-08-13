#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { Cause, Duration, Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import * as SqliteDatabase from "../../src/contexts/shared/adapters/SqliteDatabase.ts";

/**
 * Takes the file's write lock and keeps it for a while, from another process.
 *
 * Contention has to cross a process boundary to be worth testing. SQLite's busy handler *sleeps the
 * calling thread*, so a second writer inside the same process would block the first from ever
 * committing — the test would measure a deadlock rather than a wait.
 *
 * The marker file is the handshake: it is written after the insert, which is what actually takes
 * the lock, so a test that sees the marker knows the lock is held rather than merely asked for.
 */
const [database, marker, millis] = process.argv.slice(2);

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists held (id integer primary key, note text)`;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`insert into held ${sql.insert({ note: "holder" })}`;
      yield* Effect.sync(() => writeFileSync(marker ?? "", "held"));
      yield* Effect.sleep(Duration.millis(Number(millis ?? "400")));
    }),
  );
});

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(SqliteDatabase.layer({ path: database ?? "" }))),
);

if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
