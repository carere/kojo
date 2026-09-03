import type { Database } from "bun:sqlite";

interface RebuildSqliteTableOptions {
  readonly table: string;
  readonly temporary: string;
  readonly referencedTable: string;
  readonly createTemporary: string;
  readonly columns: string;
}

/** Detach a durable receipt from evidence that can have a shorter retention period. */
export const rebuildSqliteTableWithoutForeignKey = (
  database: Database,
  options: RebuildSqliteTableOptions,
): void => {
  const foreignKeys = database
    .query<{ readonly table: string }, []>(`PRAGMA foreign_key_list(${options.table})`)
    .all();
  if (!foreignKeys.some((foreignKey) => foreignKey.table === options.referencedTable)) return;

  const enabled =
    database.query<{ readonly foreign_keys: number }, []>("PRAGMA foreign_keys").get()
      ?.foreign_keys ?? 0;
  database.run("PRAGMA foreign_keys = OFF");
  try {
    database
      .transaction(() => {
        database.run(`DROP TABLE IF EXISTS ${options.temporary}`);
        database.run(options.createTemporary);
        database.run(
          `INSERT INTO ${options.temporary} (${options.columns}) SELECT ${options.columns} FROM ${options.table}`,
        );
        database.run(`DROP TABLE ${options.table}`);
        database.run(`ALTER TABLE ${options.temporary} RENAME TO ${options.table}`);
      })
      .immediate();
  } finally {
    if (enabled === 1) database.run("PRAGMA foreign_keys = ON");
  }

  const retainedForeignKeys = database
    .query<{ readonly table: string }, []>(`PRAGMA foreign_key_list(${options.table})`)
    .all();
  if (retainedForeignKeys.some((foreignKey) => foreignKey.table === options.referencedTable)) {
    throw new Error(`Kojo cannot separate ${options.table} retention ownership`);
  }
  if (database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error(`Kojo cannot verify ${options.table} foreign keys after migration`);
  }
};
