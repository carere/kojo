import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer, Schema } from "effect";
import { ProjectStore } from "../../contexts/workflow-execution/projects/services/project-store";
import { workflowRuns, workflowScheduleStates } from "./project-store-schema";

const ScheduleBlockerRows = Schema.Array(Schema.Struct({ scheduleKey: Schema.String }));
const RunBlockerRows = Schema.Array(Schema.Struct({ runId: Schema.String }));
const CURRENT_VERSION = 1;
const REQUIRED_OBJECTS = [
  "kojo_schema_migrations",
  "kojo_workflow_runs",
  "kojo_workflow_schedule_states",
  "kojo_schedule_states_due_idx",
  "kojo_schedule_states_workflow_idx",
  "kojo_workflow_runs_accepted_idx",
  "kojo_workflow_runs_non_final_idx",
  "kojo_workflow_runs_parent_idx",
  "kojo_workflow_runs_schedule_idx",
  "kojo_workflow_runs_state_updated_idx",
  "kojo_workflow_runs_workflow_idx",
] as const;

const migration = readFileSync(
  fileURLToPath(new URL("./migrations/0001_project_lifecycle.sql", import.meta.url)),
  "utf8",
);
const migrationChecksum = createHash("sha256").update(migration).digest("hex");

const databasePath = (projectPath: string) => join(projectPath, ".kojo", "kojo.sqlite");

const assertDatabaseFile = (path: string) => {
  const information = lstatSync(path);
  const userId = process.getuid?.();
  if (
    information.isSymbolicLink() ||
    !information.isFile() ||
    (userId !== undefined && information.uid !== userId) ||
    (information.mode & 0o777) !== 0o600
  ) {
    throw new Error("unsafe Project database");
  }
};

const pragmaNumber = (connection: Database, name: string) => {
  const row = connection.query(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  return row?.[name];
};

const assertIntegrity = (connection: Database) => {
  const row = connection.query("PRAGMA quick_check").get() as
    | { readonly quick_check: string }
    | undefined;
  if (row?.quick_check !== "ok") throw new Error("Project database integrity check failed");
  if (connection.query("PRAGMA foreign_key_check").get() !== null) {
    throw new Error("Project database foreign key check failed");
  }
};

const configureWritable = (connection: Database) => {
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA synchronous = FULL");
  const journal = connection.query("PRAGMA journal_mode = WAL").get() as
    | { readonly journal_mode: string }
    | undefined;
  if (
    journal?.journal_mode.toLowerCase() !== "wal" ||
    pragmaNumber(connection, "foreign_keys") !== 1 ||
    pragmaNumber(connection, "synchronous") !== 2
  ) {
    throw new Error("Project database safety settings are unavailable");
  }
};

const configureReadOnly = (connection: Database) => {
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA query_only = ON");
};

const version = (connection: Database) =>
  (connection.query("PRAGMA user_version").get() as { readonly user_version: number }).user_version;

const assertCurrentSchema = (connection: Database) => {
  if (version(connection) !== CURRENT_VERSION) throw new Error("unsupported Project store version");
  const migrationRow = connection
    .query("SELECT checksum FROM kojo_schema_migrations WHERE version = ?")
    .get(CURRENT_VERSION) as { readonly checksum: string } | undefined;
  if (migrationRow?.checksum !== migrationChecksum) {
    throw new Error("Project store migration checksum mismatch");
  }
  const rows = connection
    .query(
      `SELECT name, type, sql FROM sqlite_master WHERE name IN (${REQUIRED_OBJECTS.map(() => "?").join(", ")})`,
    )
    .all(...REQUIRED_OBJECTS) as Array<{
    readonly name: string;
    readonly sql: string;
    readonly type: string;
  }>;
  if (rows.length !== REQUIRED_OBJECTS.length)
    throw new Error("Project store schema is incomplete");
  for (const table of rows.filter((row) => row.type === "table")) {
    if (!/\bSTRICT\s*$/i.test(table.sql.trim())) {
      throw new Error("Project store table is not STRICT");
    }
  }
};

const assertProjectIdentity = (project: { readonly identity: string; readonly path: string }) => {
  const metadata = JSON.parse(
    readFileSync(join(project.path, ".kojo", "project.json"), "utf8"),
  ) as { readonly layoutVersion?: unknown; readonly projectIdentity?: unknown };
  if (metadata.layoutVersion !== 1 || metadata.projectIdentity !== project.identity) {
    throw new Error("Project Identity does not match its database owner");
  }
};

const verifyBackup = (path: string) => {
  assertDatabaseFile(path);
  const backup = new Database(path, { readonly: true, strict: true });
  try {
    configureReadOnly(backup);
    assertIntegrity(backup);
  } finally {
    backup.close();
  }
};

export const migrateProjectStore = (project: {
  readonly identity: string;
  readonly path: string;
}) => {
  const path = databasePath(project.path);
  const backupPath = `${path}.migration-backup`;
  if (existsSync(backupPath)) {
    verifyBackup(backupPath);
    copyFileSync(backupPath, path);
    chmodSync(path, 0o600);
  }
  assertDatabaseFile(path);
  assertProjectIdentity(project);
  const connection = new Database(path, { create: false, strict: true });
  let succeeded = false;
  try {
    configureWritable(connection);
    assertIntegrity(connection);
    const current = version(connection);
    if (current > CURRENT_VERSION) throw new Error("unsupported Project store version");
    if (current === CURRENT_VERSION) {
      assertCurrentSchema(connection);
      return;
    }

    if (existsSync(backupPath)) unlinkSync(backupPath);
    connection.query("VACUUM INTO ?").run(backupPath);
    chmodSync(backupPath, 0o600);
    const backupHandle = openSync(backupPath, "r");
    try {
      fsyncSync(backupHandle);
    } finally {
      closeSync(backupHandle);
    }
    verifyBackup(backupPath);
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(migration);
      connection
        .query("INSERT INTO kojo_schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)")
        .run(CURRENT_VERSION, migrationChecksum, new Date().toISOString());
      connection.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
      assertCurrentSchema(connection);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
    assertIntegrity(connection);
    succeeded = true;
  } finally {
    connection.close();
    if (succeeded) {
      if (existsSync(backupPath)) unlinkSync(backupPath);
    } else if (existsSync(backupPath)) {
      verifyBackup(backupPath);
      copyFileSync(backupPath, path);
      chmodSync(path, 0o600);
    }
  }
};

const inspectReadiness = (projectPath: string) => {
  try {
    const path = databasePath(projectPath);
    assertDatabaseFile(path);
    const connection = new Database(path, { readonly: true, strict: true });
    try {
      configureReadOnly(connection);
      assertIntegrity(connection);
      const current = version(connection);
      if (current === 0) return "limited" as const;
      assertCurrentSchema(connection);
      return "ready" as const;
    } finally {
      connection.close();
    }
  } catch {
    return "needs-attention" as const;
  }
};

const inspectBlockers = (projectPath: string) => {
  try {
    const path = databasePath(projectPath);
    assertDatabaseFile(path);
    const connection = new Database(path, { readonly: true, strict: true });
    try {
      configureReadOnly(connection);
      assertIntegrity(connection);
      assertCurrentSchema(connection);
      const store = drizzle(connection);
      const scheduleRows = store
        .select({ scheduleKey: workflowScheduleStates.scheduleKey })
        .from(workflowScheduleStates)
        .where(eq(workflowScheduleStates.enabledIntent, 1))
        .orderBy(asc(workflowScheduleStates.scheduleKey))
        .all();
      const enabledScheduleKeys = Schema.decodeUnknownSync(ScheduleBlockerRows)(scheduleRows).map(
        ({ scheduleKey }) => scheduleKey,
      );
      const runRows = store
        .select({ runId: workflowRuns.runId })
        .from(workflowRuns)
        .where(inArray(workflowRuns.state, ["running", "suspended", "stopping"]))
        .orderBy(asc(workflowRuns.runId))
        .all();
      const nonFinalRunIds = Schema.decodeUnknownSync(RunBlockerRows)(runRows).map(
        ({ runId }) => runId,
      );
      return { assessment: "available" as const, enabledScheduleKeys, nonFinalRunIds };
    } finally {
      connection.close();
    }
  } catch {
    return {
      assessment: "unavailable" as const,
      enabledScheduleKeys: [],
      nonFinalRunIds: [],
    };
  }
};

export const DrizzleProjectStoreLive = Layer.sync(ProjectStore, () => {
  const attemptedMigrations = new Set<string>();
  return {
    migrate: (project) =>
      Effect.sync(() => {
        if (inspectReadiness(project.path) === "ready") return true;
        if (attemptedMigrations.has(project.identity)) return false;
        attemptedMigrations.add(project.identity);
        try {
          migrateProjectStore(project);
          return true;
        } catch {
          return false;
        }
      }),
    readiness: (project) => Effect.sync(() => inspectReadiness(project.path)),
    inspectForgetBlockers: (project) => Effect.sync(() => inspectBlockers(project.path)),
  };
});
