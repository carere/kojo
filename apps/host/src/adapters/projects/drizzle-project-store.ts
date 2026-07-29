import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
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
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect, Layer, Schema } from "effect";
import { ProjectStore } from "../../contexts/workflow-execution/projects/services/project-store";
import { workflowRuns, workflowScheduleStates } from "./project-store-schema";

const ScheduleBlockerRows = Schema.Array(Schema.Struct({ scheduleKey: Schema.String }));
const RunBlockerRows = Schema.Array(Schema.Struct({ runId: Schema.String }));
const CURRENT_VERSION = 1;
const ENGINE_ADAPTER_KIND = "effect-workflow";
const ENGINE_ADAPTER_SCHEMA_VERSION = 1;
const EFFECT_FAMILY_VERSION = "4.0.0-beta.102";
const REQUIRED_OBJECTS = [
  "kojo_schema_migrations",
  "kojo_store_metadata",
  "kojo_control_requests",
  "kojo_control_requests_active_idx",
  "kojo_control_requests_expiry_idx",
  "kojo_control_requests_run_idx",
  "kojo_control_requests_schedule_idx",
  "kojo_workflow_runs",
  "kojo_workflow_schedule_states",
  "kojo_workflow_schedule_occurrences",
  "kojo_schedule_occurrences_history_idx",
  "kojo_schedule_occurrences_outcome_idx",
  "kojo_schedule_occurrences_due_idx",
  "kojo_schedule_occurrences_linked_run_unique",
  "kojo_engine_operations",
  "kojo_engine_operations_run_idx",
  "kojo_engine_operations_pending_idx",
  "kojo_workflow_activity_attempts",
  "kojo_activity_attempts_run_idx",
  "kojo_activity_attempts_idempotency_idx",
  "kojo_execution_events",
  "kojo_execution_events_kind_idx",
  "kojo_execution_events_engine_operation_idx",
  "kojo_execution_events_activity_attempt_idx",
  "kojo_execution_events_boundary_idx",
  "kojo_execution_events_child_run_idx",
  "kojo_execution_artifacts",
  "kojo_execution_artifacts_run_idx",
  "kojo_execution_artifacts_condition_idx",
  "kojo_execution_event_artifacts",
  "kojo_retention_policy",
  "kojo_deletion_intents",
  "kojo_deletion_intents_active_idx",
  "kojo_deletion_items",
  "kojo_deletion_items_next_idx",
  "kojo_execution_events_immutable",
  "kojo_schedule_states_due_idx",
  "kojo_schedule_states_workflow_idx",
  "kojo_workflow_runs_accepted_idx",
  "kojo_workflow_runs_non_final_idx",
  "kojo_workflow_runs_parent_idx",
  "kojo_workflow_runs_schedule_idx",
  "kojo_workflow_runs_state_updated_idx",
  "kojo_workflow_runs_workflow_idx",
] as const;

const migrationFolder = fileURLToPath(new URL("./migrations", import.meta.url));

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

const assertStoreMetadata = (
  connection: Database,
  project: { readonly identity: string },
  expectedVersion: number,
) => {
  const metadata = connection
    .query(
      "SELECT project_identity, store_format_version, engine_adapter_kind, engine_adapter_schema_version, effect_family_version FROM kojo_store_metadata WHERE singleton_key = 1",
    )
    .get() as
    | {
        readonly project_identity: string;
        readonly store_format_version: number;
        readonly engine_adapter_kind: string;
        readonly engine_adapter_schema_version: number;
        readonly effect_family_version: string;
      }
    | undefined;
  if (
    metadata?.project_identity !== project.identity ||
    metadata.store_format_version !== expectedVersion ||
    metadata.engine_adapter_kind !== ENGINE_ADAPTER_KIND ||
    metadata.engine_adapter_schema_version !== ENGINE_ADAPTER_SCHEMA_VERSION ||
    metadata.effect_family_version !== EFFECT_FAMILY_VERSION
  ) {
    throw new Error("Project store ownership or engine compatibility mismatch");
  }
};

const assertCurrentSchema = (connection: Database, project: { readonly identity: string }) => {
  if (version(connection) !== CURRENT_VERSION) throw new Error("unsupported Project store version");
  const migrationRow = connection
    .query("SELECT hash FROM kojo_schema_migrations ORDER BY created_at DESC LIMIT 1")
    .get() as { readonly hash: string } | undefined;
  if (migrationRow?.hash !== migrationChecksum) {
    throw new Error("Project store migration checksum mismatch");
  }
  assertStoreMetadata(connection, project, CURRENT_VERSION);
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
  for (const table of rows.filter(
    (row) => row.type === "table" && row.name !== "kojo_schema_migrations",
  )) {
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

const verifyBackup = (path: string, project: { readonly identity: string }) => {
  assertDatabaseFile(path);
  const backup = new Database(path, { readonly: true, strict: true });
  try {
    configureReadOnly(backup);
    assertIntegrity(backup);
    const backupVersion = version(backup);
    if (backupVersion > CURRENT_VERSION) throw new Error("unsupported Project store version");
    assertStoreMetadata(backup, project, backupVersion);
    if (backupVersion === CURRENT_VERSION) assertCurrentSchema(backup, project);
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
    verifyBackup(backupPath, project);
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
    assertStoreMetadata(connection, project, current);
    if (current === CURRENT_VERSION) {
      assertCurrentSchema(connection, project);
      succeeded = true;
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
    verifyBackup(backupPath, project);
    migrate(drizzle(connection), {
      migrationsFolder: migrationFolder,
      migrationsTable: "kojo_schema_migrations",
    });
    const migratedAt = Date.now();
    connection
      .query(
        "UPDATE kojo_store_metadata SET database_instance_id = COALESCE(NULLIF(database_instance_id, ''), ?), store_format_version = ?, engine_adapter_kind = ?, engine_adapter_schema_version = ?, effect_family_version = ?, last_migrated_at_ms = ? WHERE singleton_key = 1 AND project_identity = ?",
      )
      .run(
        randomUUID(),
        CURRENT_VERSION,
        ENGINE_ADAPTER_KIND,
        ENGINE_ADAPTER_SCHEMA_VERSION,
        EFFECT_FAMILY_VERSION,
        migratedAt,
        project.identity,
      );
    connection.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
    assertCurrentSchema(connection, project);
    assertIntegrity(connection);
    connection.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    succeeded = true;
  } finally {
    connection.close();
    if (succeeded) {
      if (existsSync(backupPath)) unlinkSync(backupPath);
    } else if (existsSync(backupPath)) {
      verifyBackup(backupPath, project);
      copyFileSync(backupPath, path);
      chmodSync(path, 0o600);
    }
  }
};

const inspectReadiness = (project: { readonly identity: string; readonly path: string }) => {
  try {
    const path = databasePath(project.path);
    if (existsSync(`${path}.migration-backup`)) return "needs-attention" as const;
    assertDatabaseFile(path);
    const connection = new Database(path, { readonly: true, strict: true });
    try {
      configureReadOnly(connection);
      assertIntegrity(connection);
      const current = version(connection);
      assertStoreMetadata(connection, project, current);
      if (current === 0) return "limited" as const;
      assertCurrentSchema(connection, project);
      return "ready" as const;
    } finally {
      connection.close();
    }
  } catch {
    return "needs-attention" as const;
  }
};

const inspectBlockers = (project: { readonly identity: string; readonly path: string }) => {
  try {
    const path = databasePath(project.path);
    if (existsSync(`${path}.migration-backup`))
      throw new Error("Project migration recovery pending");
    assertDatabaseFile(path);
    const connection = new Database(path, { readonly: true, strict: true });
    try {
      configureReadOnly(connection);
      assertIntegrity(connection);
      assertCurrentSchema(connection, project);
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
        if (inspectReadiness(project) === "ready") return true;
        if (attemptedMigrations.has(project.identity)) return false;
        attemptedMigrations.add(project.identity);
        try {
          migrateProjectStore(project);
          return true;
        } catch {
          return false;
        }
      }),
    readiness: (project) => Effect.sync(() => inspectReadiness(project)),
    inspectForgetBlockers: (project) => Effect.sync(() => inspectBlockers(project)),
  };
});
