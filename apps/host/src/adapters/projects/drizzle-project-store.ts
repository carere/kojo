import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect, Layer, Schema } from "effect";
import { ProjectStore } from "../../contexts/workflow-execution/projects/services/project-store";
import {
  deletionIntents,
  executionEvents,
  projectStoreIdentityBootstrap,
  schemaMigrations,
  storeMetadata,
  workflowRuns,
  workflowScheduleStates,
} from "./project-store-schema";

const ScheduleBlockerRows = Schema.Array(Schema.Struct({ scheduleKey: Schema.String }));
const RunBlockerRows = Schema.Array(Schema.Struct({ runId: Schema.String }));
const StoreMetadataRows = Schema.Array(
  Schema.Struct({
    projectIdentity: Schema.String,
    storeFormatVersion: Schema.Int,
    engineAdapterKind: Schema.String,
    engineAdapterSchemaVersion: Schema.Int,
    effectFamilyVersion: Schema.String,
  }),
);
const BootstrapIdentityRows = Schema.Array(
  Schema.Struct({
    projectIdentity: Schema.String,
    databaseInstanceId: Schema.String,
  }),
);
const MigrationRows = Schema.Array(Schema.Struct({ hash: Schema.String }));
const DeletionRows = Schema.Array(Schema.Struct({ deletionId: Schema.String }));
const SemanticRunRows = Schema.Array(
  Schema.Struct({
    runId: Schema.String,
    state: Schema.String,
    lastEventSequence: Schema.Int,
    engineReferenceVersion: Schema.Int,
    engineReferenceJson: Schema.String,
  }),
);
const SemanticEventRows = Schema.Array(
  Schema.Struct({ runId: Schema.String, sequence: Schema.Int, kind: Schema.String }),
);
const ProjectMetadataFile = Schema.Struct({
  layoutVersion: Schema.Literal(1),
  projectIdentity: Schema.String,
});
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
  return information;
};

const assertSidecar = (path: string) => {
  if (!existsSync(path)) return;
  const information = lstatSync(path);
  const userId = process.getuid?.();
  if (
    information.isSymbolicLink() ||
    !information.isFile() ||
    (userId !== undefined && information.uid !== userId)
  ) {
    throw new Error("unsafe Project database sidecar");
  }
};

const fsyncDirectory = (path: string) => {
  const handle = openSync(dirname(path), "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
};

const fsyncFile = (path: string) => {
  const handle = openSync(path, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
};

const removeSidecars = (path: string) => {
  const sidecars = [`${path}-wal`, `${path}-shm`];
  for (const sidecar of sidecars) assertSidecar(sidecar);
  for (const sidecar of sidecars) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
};

const restoreBackup = (backupPath: string, path: string) => {
  const original = assertDatabaseFile(path);
  assertDatabaseFile(backupPath);
  removeSidecars(path);
  const temporaryPath = `${path}.${randomUUID()}.restore`;
  try {
    copyFileSync(backupPath, temporaryPath, constants.COPYFILE_EXCL);
    chmodSync(temporaryPath, 0o600);
    const handle = openSync(temporaryPath, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    const current = assertDatabaseFile(path);
    if (current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("Project database changed during recovery");
    }
    renameSync(temporaryPath, path);
    removeSidecars(path);
    fsyncDirectory(path);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
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
  const metadata = Schema.decodeUnknownSync(StoreMetadataRows)(
    drizzle(connection)
      .select({
        projectIdentity: storeMetadata.projectIdentity,
        storeFormatVersion: storeMetadata.storeFormatVersion,
        engineAdapterKind: storeMetadata.engineAdapterKind,
        engineAdapterSchemaVersion: storeMetadata.engineAdapterSchemaVersion,
        effectFamilyVersion: storeMetadata.effectFamilyVersion,
      })
      .from(storeMetadata)
      .where(eq(storeMetadata.singletonKey, 1))
      .limit(1)
      .all(),
  )[0];
  if (
    metadata?.projectIdentity !== project.identity ||
    metadata.storeFormatVersion !== expectedVersion ||
    metadata.engineAdapterKind !== ENGINE_ADAPTER_KIND ||
    metadata.engineAdapterSchemaVersion !== ENGINE_ADAPTER_SCHEMA_VERSION ||
    metadata.effectFamilyVersion !== EFFECT_FAMILY_VERSION
  ) {
    throw new Error("Project store ownership or engine compatibility mismatch");
  }
};

const assertVersionZero = (connection: Database, project: { readonly identity: string }) => {
  const objects = connection
    .query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as ReadonlyArray<{ readonly name: string }>;
  if (objects.length !== 1 || objects[0]?.name !== "kojo_project_store_identity") {
    throw new Error("unsupported version-zero Project store");
  }
  const identity = Schema.decodeUnknownSync(BootstrapIdentityRows)(
    drizzle(connection)
      .select({
        projectIdentity: projectStoreIdentityBootstrap.projectIdentity,
        databaseInstanceId: projectStoreIdentityBootstrap.databaseInstanceId,
      })
      .from(projectStoreIdentityBootstrap)
      .where(eq(projectStoreIdentityBootstrap.singletonKey, 1))
      .limit(1)
      .all(),
  )[0];
  if (identity?.projectIdentity !== project.identity || identity.databaseInstanceId.length === 0) {
    throw new Error("version-zero Project store identity mismatch");
  }
  return identity.databaseInstanceId;
};

const assertCurrentSchema = (connection: Database, project: { readonly identity: string }) => {
  if (version(connection) !== CURRENT_VERSION) throw new Error("unsupported Project store version");
  const migrationRow = Schema.decodeUnknownSync(MigrationRows)(
    drizzle(connection)
      .select({ hash: schemaMigrations.hash })
      .from(schemaMigrations)
      .orderBy(desc(schemaMigrations.createdAt))
      .limit(1)
      .all(),
  )[0];
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

const assertActivationSemantics = (connection: Database) => {
  const store = drizzle(connection);
  const pendingDeletion = Schema.decodeUnknownSync(DeletionRows)(
    store.select({ deletionId: deletionIntents.deletionId }).from(deletionIntents).limit(1).all(),
  );
  if (pendingDeletion.length > 0) {
    throw new Error("Project deletion recovery is pending");
  }

  const runs = Schema.decodeUnknownSync(SemanticRunRows)(
    store
      .select({
        runId: workflowRuns.runId,
        state: workflowRuns.state,
        lastEventSequence: workflowRuns.lastEventSequence,
        engineReferenceVersion: workflowRuns.engineReferenceVersion,
        engineReferenceJson: workflowRuns.engineReferenceJson,
      })
      .from(workflowRuns)
      .all(),
  );
  const events = Schema.decodeUnknownSync(SemanticEventRows)(
    store
      .select({
        runId: executionEvents.runId,
        sequence: executionEvents.sequence,
        kind: executionEvents.kind,
      })
      .from(executionEvents)
      .all(),
  );
  const engineMappings = new Set<string>();
  for (const run of runs) {
    const mapping = `${run.engineReferenceVersion}:${run.engineReferenceJson}`;
    if (engineMappings.has(mapping)) {
      throw new Error("Project Workflow Run engine mappings are not unique");
    }
    engineMappings.add(mapping);
    if (!["running", "suspended", "stopping"].includes(run.state)) continue;
    const runEvents = events.filter((event) => event.runId === run.runId);
    const lastSequence = runEvents.reduce((highest, event) => Math.max(highest, event.sequence), 0);
    if (
      run.lastEventSequence < 1 ||
      run.lastEventSequence !== lastSequence ||
      !runEvents.some((event) => event.sequence === 1 && event.kind === "run.accepted")
    ) {
      throw new Error("Project non-final Workflow Run Event invariants are invalid");
    }
  }
};

const assertProjectIdentity = (project: { readonly identity: string; readonly path: string }) => {
  const metadata = Schema.decodeUnknownSync(ProjectMetadataFile)(
    JSON.parse(readFileSync(join(project.path, ".kojo", "project.json"), "utf8")),
  );
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
    if (backupVersion === 0) assertVersionZero(backup, project);
    else assertStoreMetadata(backup, project, backupVersion);
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
  const completedBackupPath = `${backupPath}.completed`;
  if (existsSync(completedBackupPath)) {
    assertDatabaseFile(completedBackupPath);
    try {
      unlinkSync(completedBackupPath);
      fsyncDirectory(path);
    } catch {
      // A previous durable completion marker is safe to replace after the next migration.
    }
  }
  if (existsSync(backupPath)) {
    assertDatabaseFile(path);
    verifyBackup(backupPath, project);
    restoreBackup(backupPath, path);
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
    const versionZeroDatabaseId =
      current === 0 ? assertVersionZero(connection, project) : undefined;
    if (current !== 0) assertStoreMetadata(connection, project, current);
    if (current === CURRENT_VERSION) {
      assertCurrentSchema(connection, project);
      assertActivationSemantics(connection);
    }

    if (!existsSync(backupPath)) {
      connection.query("VACUUM INTO ?").run(backupPath);
      chmodSync(backupPath, 0o600);
      const backupHandle = openSync(backupPath, "r");
      try {
        fsyncSync(backupHandle);
      } finally {
        closeSync(backupHandle);
      }
      fsyncDirectory(backupPath);
      verifyBackup(backupPath, project);
    }
    if (current < CURRENT_VERSION) {
      if (versionZeroDatabaseId === undefined) {
        throw new Error("version-zero Project store identity is unavailable");
      }
      const projectStore = drizzle(connection);
      migrate(projectStore, {
        migrationsFolder: migrationFolder,
        migrationsTable: "kojo_schema_migrations",
      });
      const migratedAt = Date.now();
      projectStore
        .insert(storeMetadata)
        .values({
          singletonKey: 1,
          projectIdentity: project.identity,
          databaseInstanceId: versionZeroDatabaseId,
          storeFormatVersion: 0,
          engineAdapterKind: ENGINE_ADAPTER_KIND,
          engineAdapterSchemaVersion: ENGINE_ADAPTER_SCHEMA_VERSION,
          effectFamilyVersion: EFFECT_FAMILY_VERSION,
          createdAtMs: migratedAt,
          lastMigratedAtMs: migratedAt,
        })
        .onConflictDoNothing()
        .run();
      projectStore
        .update(storeMetadata)
        .set({
          storeFormatVersion: CURRENT_VERSION,
          engineAdapterKind: ENGINE_ADAPTER_KIND,
          engineAdapterSchemaVersion: ENGINE_ADAPTER_SCHEMA_VERSION,
          effectFamilyVersion: EFFECT_FAMILY_VERSION,
          lastMigratedAtMs: migratedAt,
        })
        .where(
          and(
            eq(storeMetadata.singletonKey, 1),
            eq(storeMetadata.projectIdentity, project.identity),
          ),
        )
        .run();
      connection.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
    }
    assertCurrentSchema(connection, project);
    assertActivationSemantics(connection);
    assertIntegrity(connection);
    connection.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    succeeded = true;
  } finally {
    connection.close();
    if (!succeeded && existsSync(backupPath)) {
      verifyBackup(backupPath, project);
      restoreBackup(backupPath, path);
    }
  }
};

export const completeProjectStoreMigration = (
  project: { readonly identity: string; readonly path: string },
  succeeded: boolean,
  durability: { readonly syncDirectory: (path: string) => void } = {
    syncDirectory: fsyncDirectory,
  },
) => {
  const path = databasePath(project.path);
  const backupPath = `${path}.migration-backup`;
  const completedBackupPath = `${backupPath}.completed`;
  const recoveryPath = existsSync(backupPath)
    ? backupPath
    : existsSync(completedBackupPath)
      ? completedBackupPath
      : undefined;
  if (recoveryPath === undefined) return succeeded;
  verifyBackup(recoveryPath, project);
  if (!succeeded) {
    restoreBackup(recoveryPath, path);
    if (recoveryPath === completedBackupPath) {
      renameSync(completedBackupPath, backupPath);
      fsyncDirectory(path);
    }
    return false;
  }
  assertDatabaseFile(path);
  assertProjectIdentity(project);
  const connection = new Database(path, { readonly: true, strict: true });
  try {
    configureReadOnly(connection);
    assertIntegrity(connection);
    assertCurrentSchema(connection, project);
    assertActivationSemantics(connection);
  } finally {
    connection.close();
  }
  fsyncFile(path);
  if (recoveryPath === backupPath) renameSync(backupPath, completedBackupPath);
  durability.syncDirectory(path);
  try {
    assertDatabaseFile(completedBackupPath);
    unlinkSync(completedBackupPath);
    fsyncDirectory(path);
  } catch {
    // A durable completion marker is safe to remove during a later activation.
  }
  return true;
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
      if (current === 0) {
        assertVersionZero(connection, project);
        return "limited" as const;
      }
      assertStoreMetadata(connection, project, current);
      assertCurrentSchema(connection, project);
      assertActivationSemantics(connection);
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
  const failedMigrations = new Set<string>();
  const failureKey = (project: { readonly identity: string; readonly path: string }) =>
    `${project.identity}:${project.path}`;
  return {
    migrate: (project) =>
      Effect.sync(() => {
        if (failedMigrations.has(failureKey(project))) return false;
        const path = databasePath(project.path);
        const backupPath = `${path}.migration-backup`;
        const attemptKey = existsSync(backupPath)
          ? `${project.path}:backup:${lstatSync(backupPath).dev}:${lstatSync(backupPath).ino}`
          : `${project.path}:store`;
        if (attemptedMigrations.has(attemptKey)) return false;
        attemptedMigrations.add(attemptKey);
        try {
          migrateProjectStore(project);
          return true;
        } catch {
          failedMigrations.add(failureKey(project));
          return false;
        }
      }),
    postflight: (project) =>
      Effect.sync(() => {
        try {
          const path = databasePath(project.path);
          assertDatabaseFile(path);
          assertProjectIdentity(project);
          const connection = new Database(path, { readonly: true, strict: true });
          try {
            configureReadOnly(connection);
            assertIntegrity(connection);
            assertCurrentSchema(connection, project);
            assertActivationSemantics(connection);
            return true;
          } finally {
            connection.close();
          }
        } catch {
          return false;
        }
      }),
    completeMigration: (project, succeeded) =>
      Effect.sync(() => {
        try {
          const completed = completeProjectStoreMigration(project, succeeded);
          if (completed) {
            const prefix = `${project.path}:`;
            for (const attempt of attemptedMigrations) {
              if (attempt.startsWith(prefix)) attemptedMigrations.delete(attempt);
            }
          } else {
            failedMigrations.add(failureKey(project));
          }
          return completed;
        } catch {
          failedMigrations.add(failureKey(project));
          return false;
        }
      }),
    readiness: (project) => Effect.sync(() => inspectReadiness(project)),
    inspectForgetBlockers: (project) => Effect.sync(() => inspectBlockers(project)),
  };
});
