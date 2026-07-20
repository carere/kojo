import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const systemMetadata = sqliteTable("system_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

const migrations = [
  {
    id: 1,
    statements: [
      `CREATE TABLE system_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )`,
    ],
  },
] as const;

const migrationChecksum = (statements: ReadonlyArray<string>) =>
  createHash("sha256").update(statements.join(";\n")).digest("hex");

const chmodIfPresent = async (path: string) => {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

export interface SystemStore {
  readonly close: () => void;
}

export const openSystemStore = async (home: string): Promise<SystemStore> => {
  await mkdir(home, { mode: 0o700, recursive: true });
  await chmod(home, 0o700);

  const databasePath = join(home, "state.sqlite");
  const sqlite = new Database(databasePath, { create: true, strict: true });

  try {
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run("PRAGMA synchronous = FULL");
    sqlite.run("PRAGMA foreign_keys = ON");
    sqlite.run("PRAGMA busy_timeout = 5000");
    await chmod(databasePath, 0o600);
    const integrity = sqlite.query("PRAGMA integrity_check").get() as {
      integrity_check?: unknown;
    } | null;
    if (integrity?.integrity_check !== "ok") {
      throw new Error("state.sqlite failed its integrity check");
    }

    const database = drizzle(sqlite);
    database.run(
      sql.raw(`CREATE TABLE IF NOT EXISTS kojo_migrations (
      id INTEGER PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`),
    );

    const applied = database.all<{ checksum: string; id: number }>(
      sql`SELECT id, checksum FROM kojo_migrations ORDER BY id`,
    );
    const knownIds = new Set(migrations.map((migration) => migration.id));
    const unknown = applied.find((migration) => !knownIds.has(migration.id as 1));
    if (unknown !== undefined) {
      throw new Error(
        `state.sqlite schema migration ${unknown.id} is newer than this Kojo version`,
      );
    }

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.statements);
      const existing = applied.find((candidate) => candidate.id === migration.id);
      if (existing?.checksum !== undefined && existing.checksum !== checksum) {
        throw new Error(`state.sqlite migration ${migration.id} checksum does not match`);
      }
      if (existing !== undefined) {
        continue;
      }

      sqlite.transaction(() => {
        for (const statement of migration.statements) {
          database.run(sql.raw(statement));
        }
        database.run(
          sql`INSERT INTO kojo_migrations (id, checksum, applied_at)
              VALUES (${migration.id}, ${checksum}, ${new Date().toISOString()})`,
        );
      })();
    }

    database
      .insert(systemMetadata)
      .values({ key: "schema_version", value: String(migrations.length) })
      .onConflictDoUpdate({
        set: { value: String(migrations.length) },
        target: systemMetadata.key,
      })
      .run();

    await chmodIfPresent(`${databasePath}-wal`);
    await chmodIfPresent(`${databasePath}-shm`);

    return { close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
};
