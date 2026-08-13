import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { retryOnLock } from "../../shared/adapters/SqliteDatabase.ts";
import { decodeUnknown } from "../../shared/lib/decode.ts";
import { RunnerRegistration } from "../models/RunnerRegistration.ts";
import { RunnerRepository } from "../ports/RunnerRepository.ts";

/**
 * Whether the cluster has ever registered anything on this file.
 *
 * Asked rather than assumed, because a factory that has not run yet is the ordinary state of a
 * fresh repository, and `no such table` is a worse answer to *is a runner alive* than `no`.
 */
const tableExists = `
  select name from sqlite_master where type = 'table' and name = 'cluster_runners'
`;

/**
 * The age of every heartbeat, computed by the database rather than by this process.
 *
 * `last_heartbeat` is a SQLite `DATETIME` written from `CURRENT_TIMESTAMP`, which is UTC to the
 * second. Reading it back as text and subtracting a JavaScript `Date.now()` would compare two
 * clocks, one of which is the host's local time — so the subtraction happens where both values come
 * from the same clock, and this process only reads a number of milliseconds.
 */
const ageOfEach = `
  select address,
         max(0, cast((julianday(current_timestamp) - julianday(last_heartbeat)) * 86400000 as integer))
           as age_millis
    from cluster_runners
   order by age_millis
`;

interface Row {
  readonly address: string;
  readonly age_millis: number;
}

/**
 * The registration table the cluster maintains, read back and nothing else.
 *
 * It creates no table and writes no row: `SqlRunnerStorage` owns
 * `cluster_runners(machine_id, address, runner, healthy, last_heartbeat)` and maintains it from the
 * shard-lock loop. This adapter is a query over the same client — the *same* client, for the reason
 * `SqliteDatabase` insists on, because the engine's storage and this are one file.
 *
 * A failed read is a defect rather than a typed error, and that is a narrow claim: the only
 * *expected* condition is that the table is not there yet, which is answered above with an empty
 * list. Anything else this query can say is the database being broken, and a factory whose database
 * is broken has nothing left to report about anyway.
 */
export const layer: Layer.Layer<RunnerRepository, never, SqlClient.SqlClient> = Layer.effect(
  RunnerRepository,
  Effect.map(SqlClient.SqlClient, (sql) => ({
    registered: Effect.gen(function* () {
      const tables = yield* sql.unsafe<{ readonly name: string }>(tableExists);
      if (tables.length === 0) return [];

      const rows = yield* sql.unsafe<Row>(ageOfEach);
      return yield* Effect.forEach(rows, (row) =>
        decodeUnknown(RunnerRegistration)({
          address: row.address,
          heartbeatAgeMillis: row.age_millis,
        }),
      );
    }).pipe(retryOnLock, Effect.orDie),
  })),
);
