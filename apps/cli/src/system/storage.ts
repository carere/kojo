import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const systemMetadata = sqliteTable("system_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

const kojoMigrations = sqliteTable("kojo_migrations", {
  appliedAt: text("applied_at").notNull(),
  checksum: text("checksum").notNull(),
  id: integer("id").primaryKey(),
});

const projects = sqliteTable("projects", {
  createdAt: text("created_at").notNull(),
  id: text("id").primaryKey(),
  metadata: text("metadata").notNull(),
  path: text("path").notNull().unique(),
  registrationState: text("registration_state").notNull(),
  updatedAt: text("updated_at").notNull(),
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
  {
    id: 2,
    statements: [
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        path TEXT NOT NULL UNIQUE,
        registration_state TEXT NOT NULL CHECK (registration_state IN ('Enabled', 'Disabled', 'Archived')),
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
  readonly projects: ProjectRepository;
}

export type ProjectRegistrationState = "Archived" | "Disabled" | "Enabled";

export interface StoredProject {
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: string;
  readonly path: string;
  readonly registrationState: ProjectRegistrationState;
  readonly updatedAt: string;
}

export interface ProjectRepository {
  readonly create: (project: StoredProject) => StoredProject;
  readonly findById: (id: string) => StoredProject | undefined;
  readonly findByPath: (path: string) => StoredProject | undefined;
  readonly list: () => ReadonlyArray<StoredProject>;
  readonly update: (
    id: string,
    changes: Partial<Pick<StoredProject, "metadata" | "path" | "registrationState">>,
  ) => StoredProject | undefined;
}

export const openSystemStore = async (home: string): Promise<SystemStore> => {
  await mkdir(home, { mode: 0o700, recursive: true });
  await chmod(home, 0o700);

  const databasePath = join(home, "state.sqlite");
  const sqlite = new Database(databasePath, { create: true, strict: true });

  try {
    const database = drizzle(sqlite);
    database.get(sql.raw("PRAGMA journal_mode = WAL"));
    database.run(sql.raw("PRAGMA synchronous = FULL"));
    database.run(sql.raw("PRAGMA foreign_keys = ON"));
    database.run(sql.raw("PRAGMA busy_timeout = 5000"));
    await chmod(databasePath, 0o600);
    const configuration = {
      foreignKeys: database.get<[unknown]>(sql.raw("PRAGMA foreign_keys"))?.[0],
      journalMode: database.get<[unknown]>(sql.raw("PRAGMA journal_mode"))?.[0],
      synchronous: database.get<[unknown]>(sql.raw("PRAGMA synchronous"))?.[0],
    };
    if (
      configuration.foreignKeys !== 1 ||
      configuration.journalMode !== "wal" ||
      configuration.synchronous !== 2
    ) {
      throw new Error("state.sqlite could not enable its required durability settings");
    }
    const integrity = database.get<[unknown]>(sql.raw("PRAGMA integrity_check"))?.[0];
    if (integrity !== "ok") {
      throw new Error("state.sqlite failed its integrity check");
    }

    database.run(
      sql.raw(`CREATE TABLE IF NOT EXISTS kojo_migrations (
      id INTEGER PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`),
    );

    const applied = database
      .select({ checksum: kojoMigrations.checksum, id: kojoMigrations.id })
      .from(kojoMigrations)
      .orderBy(kojoMigrations.id)
      .all();
    for (const [index, appliedMigration] of applied.entries()) {
      const expected = migrations[index];
      if (expected === undefined) {
        throw new Error(
          `state.sqlite schema migration ${appliedMigration.id} is newer than this Kojo version`,
        );
      }
      if (appliedMigration.id !== expected.id) {
        throw new Error(
          `state.sqlite migrations are not an ordered prefix; expected ${expected.id} but found ${appliedMigration.id}`,
        );
      }
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

      database.transaction((transaction) => {
        for (const statement of migration.statements) {
          transaction.run(sql.raw(statement));
        }
        transaction
          .insert(kojoMigrations)
          .values({ appliedAt: new Date().toISOString(), checksum, id: migration.id })
          .run();
      });
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

    const selectProject = {
      createdAt: projects.createdAt,
      id: projects.id,
      metadata: projects.metadata,
      path: projects.path,
      registrationState: projects.registrationState,
      updatedAt: projects.updatedAt,
    };
    const decodeProject = (project: typeof projects.$inferSelect): StoredProject => ({
      ...project,
      registrationState: project.registrationState as ProjectRegistrationState,
    });
    const projectRepository: ProjectRepository = {
      create: (project) => {
        database.insert(projects).values(project).run();
        return project;
      },
      findById: (id) => {
        const project = database
          .select(selectProject)
          .from(projects)
          .where(eq(projects.id, id))
          .get();
        return project === undefined ? undefined : decodeProject(project);
      },
      findByPath: (path) => {
        const project = database
          .select(selectProject)
          .from(projects)
          .where(eq(projects.path, path))
          .get();
        return project === undefined ? undefined : decodeProject(project);
      },
      list: () =>
        database
          .select(selectProject)
          .from(projects)
          .orderBy(projects.createdAt, projects.id)
          .all()
          .map(decodeProject),
      update: (id, changes) => {
        const updatedAt = new Date().toISOString();
        database
          .update(projects)
          .set({ ...changes, updatedAt })
          .where(eq(projects.id, id))
          .run();
        const project = database
          .select(selectProject)
          .from(projects)
          .where(eq(projects.id, id))
          .get();
        return project === undefined ? undefined : decodeProject(project);
      },
    };

    return { close: () => sqlite.close(), projects: projectRepository };
  } catch (error) {
    sqlite.close();
    throw error;
  }
};
