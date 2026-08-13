import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrationsTable, retryOnLock } from "../contexts/shared/adapters/SqliteDatabase.ts";
import { migrations } from "../contexts/trace/adapters/SqliteTracer.ts";

/**
 * How far this build's trace schema goes, read from the migrations themselves.
 *
 * Derived rather than written down twice: `Migrator.fromRecord` parses `<id>_<name>` out of each
 * key, so the highest id in that record **is** the schema this build expects. A constant beside it
 * would be a second answer to one question, and it would be the one that goes stale.
 */
export const expectedSchema: number = Object.keys(migrations).reduce((highest, key) => {
  const matched = key.match(/^(\d+)_/);
  return matched === null ? highest : Math.max(highest, Number(matched[1]));
}, 0);

/** Has anything ever written Kojo's ledger into this file? Asked, because a fresh file has not. */
const ledgerExists = `
  select name from sqlite_master where type = 'table' and name = '${migrationsTable}'
`;

/**
 * How far the file on disk has been migrated. Zero when no ledger has ever been written.
 *
 * **This is read before the Console's layers are built, and that ordering is the whole point.** A
 * migration that fails is `Effect.die` rather than a typed error, so a Console that discovered an
 * old schema by *running* the migrator would take the process down instead of putting a banner on
 * screen. Reading the ledger is a `select`: it says the same thing and changes nothing.
 *
 * Nothing here migrates, and nothing here creates a table. A read port that wrote would make opening
 * a browser tab an act of writing, which is the same rule `kojo gate list` follows.
 *
 * A failure is a defect rather than a typed error, on the same narrow terms as
 * `SqliteRunnerRepository`: the one *expected* condition is that the ledger is not there yet, and
 * that is answered with zero. Anything else this query can say is the file being broken.
 */
export const appliedSchema: Effect.Effect<number, never, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql.unsafe<{ readonly name: string }>(ledgerExists);
    if (tables.length === 0) return 0;

    const rows = yield* sql.unsafe<{ readonly applied: number | null }>(
      `select max(migration_id) as applied from ${migrationsTable}`,
    );
    return rows[0]?.applied ?? 0;
  },
).pipe(retryOnLock, Effect.orDie);
