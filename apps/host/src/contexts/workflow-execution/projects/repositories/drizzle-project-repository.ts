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
import {
  EXECUTION_EVENT_KINDS_V1,
  type ExecutionTraceFilters,
  type RequestKey,
  type WorkflowRunListItem,
  type WorkflowRunSnapshot,
  type WorkflowRunSuspension,
  type WorkflowScheduleDefinition,
  type WorkflowScheduleOccurrenceSnapshot,
  type WorkflowScheduleSnapshot,
} from "@kojo/control";
import type { WorkflowScheduleSnapshot as WorkflowScheduleDefinitionSnapshot } from "@kojo/control/project-definition-validation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect, Layer, Schema } from "effect";
import {
  decodeSensitivityMap,
  encodeSensitivityMap,
  prefixedSensitivityMap,
  SENSITIVITY_MAP_VERSION,
  type SensitivityMap,
  sensitivityMap,
} from "../../runs/models/sensitivity-map";
import { decideWorkflowActivityReplay } from "../../runs/models/workflow-activity";
import { preservesStoppedOutcome } from "../../runs/models/workflow-run-stop";
import type {
  StoredExecutionArtifact,
  StoredExecutionTraceEvent,
  StoredWorkflowRunSnapshot,
} from "../../runs/repositories/workflow-run-repository";
import {
  type ExecutionTraceRead,
  type WorkflowActivityAttemptRecord,
  type WorkflowAgentTraceRecord,
  type WorkflowRunChildStartRecord,
  WorkflowRunRepository,
  type WorkflowRunScheduleStartRecord,
  type WorkflowRunStartRecord,
  type WorkflowSandboxTraceRecord,
} from "../../runs/repositories/workflow-run-repository";
import { WorkflowScheduleRepository } from "../../schedules/repositories/workflow-schedule-repository";
import { ProjectRepository } from "./project-repository";
import {
  deletionIntents,
  executionEvents,
  projectStoreIdentityBootstrap,
  schemaMigrations,
  storeMetadata,
  workflowRuns,
  workflowScheduleStates,
} from "./project-repository-schema";

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
const CURRENT_VERSION = 2;
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
  "kojo_workflow_activity_operations",
  "kojo_activity_operations_run_idx",
  "kojo_workflow_activity_attempts",
  "kojo_activity_attempts_run_idx",
  "kojo_activity_attempts_idempotency_idx",
  "kojo_activity_attempt_generation_retry_idx",
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

const migrationChecksums = [
  "0001_project_lifecycle.sql",
  "0002_schedule_reconciliation.sql",
  "0003_workflow_activity_operations.sql",
  "0004_workflow_activity_execution_generations.sql",
  "0005_workflow_activity_results.sql",
  "_0006_workflow_activity_execution_claims.sql",
].map((file) =>
  createHash("sha256")
    .update(readFileSync(fileURLToPath(new URL(`./migrations/${file}`, import.meta.url)), "utf8"))
    .digest("hex"),
);

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
  const migrationRows = Schema.decodeUnknownSync(MigrationRows)(
    drizzle(connection)
      .select({ hash: schemaMigrations.hash })
      .from(schemaMigrations)
      .orderBy(schemaMigrations.id)
      .all(),
  );
  if (
    migrationRows.length !== migrationChecksums.length ||
    migrationRows.some((migration, index) => migration.hash !== migrationChecksums[index])
  ) {
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

const assertKnownMigrationPrefix = (connection: Database) => {
  const migrationRows = Schema.decodeUnknownSync(MigrationRows)(
    drizzle(connection)
      .select({ hash: schemaMigrations.hash })
      .from(schemaMigrations)
      .orderBy(schemaMigrations.id)
      .all(),
  );
  if (
    migrationRows.length > migrationChecksums.length ||
    migrationRows.some((migration, index) => migration.hash !== migrationChecksums[index])
  ) {
    throw new Error("Project store migration checksum mismatch");
  }
};

const assertEventSequence = (
  run: { readonly lastEventSequence: number; readonly runId: string },
  events: ReadonlyArray<{ readonly kind: string; readonly sequence: number }>,
) => {
  if (run.lastEventSequence !== events.length) {
    throw new Error("Project Workflow Run Event sequence is incomplete");
  }
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      throw new Error("Project Workflow Run Event sequence is incomplete");
    }
  }
  if (events[0]?.kind !== "run.accepted") {
    throw new Error("Project Workflow Run is missing its accepted Event");
  }
};

const assertFastActivationSemantics = (connection: Database) => {
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
    const runEvents = events
      .filter((event) => event.runId === run.runId)
      .sort((left, right) => left.sequence - right.sequence);
    if (run.lastEventSequence < 1) {
      throw new Error("Project non-final Workflow Run Event invariants are invalid");
    }
    assertEventSequence(run, runEvents);
  }
};

const assertDeepPostflightSemantics = (connection: Database) => {
  const runs = connection
    .query(
      `SELECT run_id, trigger_kind, parent_run_id, schedule_key, scheduled_at_ms, state,
      outcome_event_id, last_event_sequence
     FROM kojo_workflow_runs`,
    )
    .all() as ReadonlyArray<{
    readonly last_event_sequence: number;
    readonly outcome_event_id: string | null;
    readonly parent_run_id: string | null;
    readonly run_id: string;
    readonly schedule_key: string | null;
    readonly scheduled_at_ms: number | null;
    readonly state: string;
    readonly trigger_kind: string;
  }>;
  const events = connection
    .query(
      `SELECT event_id, run_id, sequence, kind, engine_operation_id, activity_attempt_id, child_run_id
     FROM kojo_execution_events
     ORDER BY run_id ASC, sequence ASC`,
    )
    .all() as ReadonlyArray<{
    readonly activity_attempt_id: string | null;
    readonly child_run_id: string | null;
    readonly engine_operation_id: string | null;
    readonly event_id: string;
    readonly kind: string;
    readonly run_id: string;
    readonly sequence: number;
  }>;
  const occurrences = connection
    .query(
      `SELECT schedule_key, scheduled_at_ms, outcome, linked_run_id
     FROM kojo_workflow_schedule_occurrences`,
    )
    .all() as ReadonlyArray<{
    readonly linked_run_id: string | null;
    readonly outcome: string;
    readonly schedule_key: string;
    readonly scheduled_at_ms: number;
  }>;
  const operations = connection
    .query(
      `SELECT operation_id, run_id, state, confirmation_event_id
     FROM kojo_engine_operations`,
    )
    .all() as ReadonlyArray<{
    readonly confirmation_event_id: string | null;
    readonly operation_id: string;
    readonly run_id: string;
    readonly state: string;
  }>;
  const attempts = connection
    .query("SELECT attempt_id, run_id FROM kojo_workflow_activity_attempts")
    .all() as ReadonlyArray<{
    readonly attempt_id: string;
    readonly run_id: string;
  }>;
  const activityOperations = connection
    .query(
      `SELECT run_id, durable_operation_key, confirmed_attempt_id
       FROM kojo_workflow_activity_operations`,
    )
    .all() as ReadonlyArray<{
    readonly confirmed_attempt_id: string | null;
    readonly durable_operation_key: string;
    readonly run_id: string;
  }>;
  const artifacts = connection
    .query("SELECT artifact_id, run_id FROM kojo_execution_artifacts")
    .all() as ReadonlyArray<{
    readonly artifact_id: string;
    readonly run_id: string;
  }>;
  const eventArtifacts = connection
    .query("SELECT run_id, event_id, artifact_id FROM kojo_execution_event_artifacts")
    .all() as ReadonlyArray<{
    readonly artifact_id: string;
    readonly event_id: string;
    readonly run_id: string;
  }>;

  const runsById = new Map(runs.map((run) => [run.run_id, run]));
  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  const eventsByRun = new Map<string, Array<(typeof events)[number]>>();
  for (const event of events) {
    const runEvents = eventsByRun.get(event.run_id) ?? [];
    runEvents.push(event);
    eventsByRun.set(event.run_id, runEvents);
  }

  for (const run of runs) {
    const runEvents = eventsByRun.get(run.run_id) ?? [];
    assertEventSequence(
      { lastEventSequence: run.last_event_sequence, runId: run.run_id },
      runEvents,
    );
    const terminalEvents = runEvents.filter((event) =>
      ["run.completed", "run.failed", "run.stopped"].includes(event.kind),
    );
    const final = ["completed", "failed", "stopped"].includes(run.state);
    if (!final) {
      if (terminalEvents.length > 0) {
        throw new Error("Project non-final Workflow Run has a terminal Event");
      }
      continue;
    }
    const outcome =
      run.outcome_event_id === null ? undefined : eventsById.get(run.outcome_event_id);
    if (
      outcome?.run_id !== run.run_id ||
      outcome.sequence !== run.last_event_sequence ||
      outcome.kind !== `run.${run.state}` ||
      terminalEvents.length !== 1
    ) {
      throw new Error("Project Workflow Run outcome invariants are invalid");
    }
  }

  for (const run of runs) {
    if (run.trigger_kind !== "child") continue;
    const lineage = new Set<string>([run.run_id]);
    let parentId = run.parent_run_id;
    while (parentId !== null) {
      if (lineage.has(parentId)) {
        throw new Error("Project Workflow Run tree contains a cycle");
      }
      lineage.add(parentId);
      const parent = runsById.get(parentId);
      if (parent === undefined) {
        throw new Error("Project Workflow Run tree is incomplete");
      }
      parentId = parent.parent_run_id;
    }
  }

  for (const occurrence of occurrences) {
    if (occurrence.outcome !== "started" || occurrence.linked_run_id === null) continue;
    const linkedRun = runsById.get(occurrence.linked_run_id);
    if (
      linkedRun?.trigger_kind !== "schedule" ||
      linkedRun.schedule_key !== occurrence.schedule_key ||
      linkedRun.scheduled_at_ms !== occurrence.scheduled_at_ms
    ) {
      throw new Error("Project Workflow Schedule occurrence is linked to the wrong Run");
    }
  }

  const operationsById = new Map(
    operations.map((operation) => [operation.operation_id, operation]),
  );
  const attemptsById = new Map(attempts.map((attempt) => [attempt.attempt_id, attempt]));
  for (const operation of activityOperations) {
    if (operation.confirmed_attempt_id === null) continue;
    const attempt = attemptsById.get(operation.confirmed_attempt_id);
    if (
      attempt?.run_id !== operation.run_id ||
      (
        connection
          .query("SELECT state FROM kojo_workflow_activity_attempts WHERE attempt_id = ?")
          .get(operation.confirmed_attempt_id) as { readonly state: string } | null
      )?.state !== "engine-confirmed"
    ) {
      throw new Error("Project Workflow Activity Operation confirmation is invalid");
    }
  }
  for (const event of events) {
    if (event.engine_operation_id !== null) {
      const operation = operationsById.get(event.engine_operation_id);
      if (operation?.run_id !== event.run_id) {
        throw new Error("Project Engine Operation Event reference is invalid");
      }
    }
    if (event.activity_attempt_id !== null) {
      const attempt = attemptsById.get(event.activity_attempt_id);
      if (attempt?.run_id !== event.run_id) {
        throw new Error("Project Workflow Activity Attempt Event reference is invalid");
      }
    }
    if (event.child_run_id !== null) {
      const child = runsById.get(event.child_run_id);
      if (child?.trigger_kind !== "child" || child.parent_run_id !== event.run_id) {
        throw new Error("Project Workflow Run child Event reference is invalid");
      }
    }
  }
  for (const operation of operations) {
    if (operation.state !== "confirmed") continue;
    const confirmation =
      operation.confirmation_event_id === null
        ? undefined
        : eventsById.get(operation.confirmation_event_id);
    if (
      confirmation?.run_id !== operation.run_id ||
      confirmation.engine_operation_id !== operation.operation_id
    ) {
      throw new Error("Project Engine Operation confirmation is invalid");
    }
  }

  const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  for (const attachment of eventArtifacts) {
    if (
      eventsById.get(attachment.event_id)?.run_id !== attachment.run_id ||
      artifactsById.get(attachment.artifact_id)?.run_id !== attachment.run_id
    ) {
      throw new Error("Project Execution Artifact reference is invalid");
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
    else {
      assertStoreMetadata(backup, project, backupVersion);
      assertKnownMigrationPrefix(backup);
    }
  } finally {
    backup.close();
  }
};

export const migrateProjectRepository = (project: {
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
    if (current !== 0) {
      assertStoreMetadata(connection, project, current);
      assertKnownMigrationPrefix(connection);
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
    const projectStore = drizzle(connection);
    migrate(projectStore, {
      migrationsFolder: migrationFolder,
      migrationsTable: "kojo_schema_migrations",
    });
    if (current < CURRENT_VERSION) {
      const migratedAt = Date.now();
      if (current === 0) {
        if (versionZeroDatabaseId === undefined) {
          throw new Error("version-zero Project store identity is unavailable");
        }
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
      }
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
    assertFastActivationSemantics(connection);
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

export const completeProjectRepositoryMigration = (
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
    assertFastActivationSemantics(connection);
    assertDeepPostflightSemantics(connection);
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
      assertFastActivationSemantics(connection);
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

export const DrizzleProjectRepositoryLive = Layer.sync(ProjectRepository, () => {
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
          migrateProjectRepository(project);
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
            assertFastActivationSemantics(connection);
            assertDeepPostflightSemantics(connection);
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
          const completed = completeProjectRepositoryMigration(project, succeeded);
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
    retryMigration: (project) =>
      Effect.sync(() => {
        failedMigrations.delete(failureKey(project));
        const prefix = `${project.path}:`;
        for (const attempt of attemptedMigrations) {
          if (attempt.startsWith(prefix)) attemptedMigrations.delete(attempt);
        }
      }),
    inspectForgetBlockers: (project) => Effect.sync(() => inspectBlockers(project)),
  };
});

const hash = (value: string) => createHash("sha256").update(value).digest();

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const transaction = <A>(connection: Database, operation: () => A): A => {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // The statement which failed may already have rolled the transaction back.
    }
    throw error;
  }
};

const withWritableProjectStore = <A>(
  project: { readonly path: string },
  operation: (connection: Database) => A,
): A => {
  const path = databasePath(project.path);
  assertDatabaseFile(path);
  const connection = new Database(path, { strict: true });
  try {
    configureWritable(connection);
    return operation(connection);
  } finally {
    connection.close();
  }
};

type StoredSchedule = {
  readonly applied_cron: string | null;
  readonly applied_input_rule_revision: string | null;
  readonly applied_overlap_policy: string | null;
  readonly applied_revision: string | null;
  readonly applied_time_zone: string | null;
  readonly applied_workflow_key: string | null;
  readonly condition: "available" | "unavailable" | "needs-attention";
  readonly condition_reason_code: string | null;
  readonly current_cron: string | null;
  readonly current_input_rule_revision: string | null;
  readonly current_overlap_policy: string | null;
  readonly current_revision: string | null;
  readonly current_time_zone: string | null;
  readonly current_workflow_key: string | null;
  readonly enabled_intent: number;
  readonly high_water_mark_ms: number | null;
  readonly next_occurrence_ms: number | null;
  readonly row_version: number;
  readonly schedule_key: string;
};

const scheduleSelect = `
  SELECT schedule_key, enabled_intent, condition, condition_reason_code,
    current_workflow_key, current_revision, current_cron, current_time_zone,
    current_overlap_policy, current_input_rule_revision,
    applied_workflow_key, applied_revision, applied_cron, applied_time_zone,
    applied_overlap_policy, applied_input_rule_revision,
    high_water_mark_ms, next_occurrence_ms, row_version
  FROM kojo_workflow_schedule_states`;

const readStoredSchedule = (
  connection: Database,
  scheduleKey: string,
): StoredSchedule | undefined =>
  (connection
    .query(`${scheduleSelect} WHERE schedule_key = ?`)
    .get(scheduleKey) as StoredSchedule | null) ?? undefined;

const currentScheduleDefinition = (row: StoredSchedule): WorkflowScheduleDefinition | null => {
  if (
    row.current_workflow_key === null ||
    row.current_revision === null ||
    row.current_cron === null ||
    row.current_time_zone === null ||
    row.current_overlap_policy === null ||
    row.current_input_rule_revision === null
  ) {
    return null;
  }
  return {
    scheduleKey: row.schedule_key,
    workflowKey: row.current_workflow_key,
    revision: row.current_revision,
    cron: row.current_cron,
    timeZone: row.current_time_zone,
    overlapPolicy: row.current_overlap_policy as "allow" | "skip",
    inputRuleRevision: row.current_input_rule_revision,
  };
};

const toScheduleSnapshot = (row: StoredSchedule): WorkflowScheduleSnapshot => {
  const definition = currentScheduleDefinition(row);
  const allowedActions =
    row.enabled_intent === 1
      ? (["disable"] as const)
      : row.condition === "available"
        ? (["enable"] as const)
        : [];
  return {
    scheduleKey: row.schedule_key,
    definition,
    appliedRevision: row.applied_revision,
    enabledIntent: row.enabled_intent === 1,
    condition: row.condition,
    conditionReasonCode: row.condition_reason_code,
    highWaterMarkMs: row.high_water_mark_ms,
    nextOccurrenceMs: row.next_occurrence_ms,
    rowVersion: row.row_version,
    allowedActions: [...allowedActions],
  };
};

const listStoredSchedules = (connection: Database): ReadonlyArray<WorkflowScheduleSnapshot> =>
  (
    connection
      .query(`${scheduleSelect} ORDER BY schedule_key ASC`)
      .all() as ReadonlyArray<StoredSchedule>
  ).map(toScheduleSnapshot);

type StoredOccurrence = {
  readonly applied_revision: string;
  readonly delivery_attempt_count: number;
  readonly first_attempted_at_ms: number | null;
  readonly linked_run_id: string | null;
  readonly missed_range_count: number | null;
  readonly missed_range_last_scheduled_at_ms: number | null;
  readonly outcome: "planned" | "started" | "skipped" | "invalidated" | "failed";
  readonly planned_at_ms: number;
  readonly processed_at_ms: number | null;
  readonly reason_code: string | null;
  readonly resolved_input_json: string;
  readonly resolved_input_sensitivity_map_json: string;
  readonly resolved_input_sensitivity_map_version: number;
  readonly schedule_key: string;
  readonly scheduled_at_ms: number;
};

const occurrenceSelect = `
  SELECT schedule_key, scheduled_at_ms, applied_revision, resolved_input_json,
    resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json,
    outcome, reason_code, delivery_attempt_count, planned_at_ms, first_attempted_at_ms,
    processed_at_ms, linked_run_id, missed_range_count, missed_range_last_scheduled_at_ms
  FROM kojo_workflow_schedule_occurrences`;

const readStoredOccurrence = (
  connection: Database,
  scheduleKey: string,
  scheduledAtMs: number,
): StoredOccurrence | undefined =>
  (connection
    .query(`${occurrenceSelect} WHERE schedule_key = ? AND scheduled_at_ms = ?`)
    .get(scheduleKey, scheduledAtMs) as StoredOccurrence | null) ?? undefined;

const toOccurrenceSnapshot = (row: StoredOccurrence): WorkflowScheduleOccurrenceSnapshot => {
  const inputSensitivityMap = decodeSensitivityMap(
    row.resolved_input_sensitivity_map_version,
    row.resolved_input_sensitivity_map_json,
  );
  return {
    scheduleKey: row.schedule_key,
    scheduledAtMs: row.scheduled_at_ms,
    appliedRevision: row.applied_revision,
    input: JSON.parse(row.resolved_input_json),
    // Treat a corrupt stored map as fully sensitive. Occurrences are visible through
    // control surfaces, so falling back to an empty map could expose a persisted input.
    inputSensitivityPaths: inputSensitivityMap.valid ? [...inputSensitivityMap.map.paths] : ["$"],
    outcome: row.outcome,
    reasonCode: row.reason_code,
    deliveryAttemptCount: row.delivery_attempt_count,
    plannedAtMs: row.planned_at_ms,
    firstAttemptedAtMs: row.first_attempted_at_ms,
    processedAtMs: row.processed_at_ms,
    linkedRunId: row.linked_run_id,
    missedRange:
      row.missed_range_count === null || row.missed_range_last_scheduled_at_ms === null
        ? null
        : {
            count: row.missed_range_count,
            firstScheduledAtMs: row.scheduled_at_ms,
            lastScheduledAtMs: row.missed_range_last_scheduled_at_ms,
          },
  };
};

const toScheduleDefinition = (
  definition: WorkflowScheduleDefinitionSnapshot,
): WorkflowScheduleDefinition => ({
  scheduleKey: definition.scheduleKey,
  workflowKey: definition.workflowKey,
  revision: definition.revision,
  cron: definition.cron,
  timeZone: definition.timeZone,
  overlapPolicy: definition.overlapPolicy,
  inputRuleRevision: definition.inputRuleRevision,
});

const sameScheduleDefinition = (row: StoredSchedule, definition: WorkflowScheduleDefinition) =>
  row.current_workflow_key === definition.workflowKey &&
  row.current_revision === definition.revision &&
  row.current_cron === definition.cron &&
  row.current_time_zone === definition.timeZone &&
  row.current_overlap_policy === definition.overlapPolicy &&
  row.current_input_rule_revision === definition.inputRuleRevision &&
  row.applied_workflow_key === definition.workflowKey &&
  row.applied_revision === definition.revision &&
  row.applied_cron === definition.cron &&
  row.applied_time_zone === definition.timeZone &&
  row.applied_overlap_policy === definition.overlapPolicy &&
  row.applied_input_rule_revision === definition.inputRuleRevision;

const safeTimestamp = (value: number) => Math.max(0, Math.floor(value));

const insertScheduleReceipt = (
  connection: Database,
  options: {
    readonly acceptedAtMs: number;
    readonly operationKind: "schedule.disable" | "schedule.enable";
    readonly requestHash: Uint8Array;
    readonly requestKey: RequestKey;
    readonly scheduleKey: string;
  },
) => {
  const resultJson = JSON.stringify({ scheduleKey: options.scheduleKey });
  connection
    .query(
      `INSERT INTO kojo_control_requests(
        request_key, operation_kind, request_sha256, target_kind, target_schedule_key, state,
        result_encoding_version, result_schema_identity, result_json,
        result_sensitivity_map_version, result_sensitivity_map_json, result_sha256,
        created_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, 'schedule', ?, 'completed', 1, 'kojo.workflow-schedule-control/v1', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.requestKey,
      options.operationKind,
      options.requestHash,
      options.scheduleKey,
      resultJson,
      SENSITIVITY_MAP_VERSION,
      encodeSensitivityMap(sensitivityMap([])),
      hash(resultJson),
      options.acceptedAtMs,
      options.acceptedAtMs,
    );
};

type StoredRun = {
  readonly accepted_at_ms: number;
  readonly engine_confirmed_at_ms: number | null;
  readonly finalized_at_ms: number | null;
  readonly outcome_summary_json: string | null;
  readonly outcome_event_id: string | null;
  readonly parent_run_id: string | null;
  readonly child_invocation_key: string | null;
  readonly run_id: string;
  readonly start_request_key: string;
  readonly state: string;
  readonly suspension_details_json: string | null;
  readonly suspension_kind: string | null;
  readonly updated_at_ms: number;
  readonly workflow_key: string;
  readonly workflow_revision: string;
};

const readStoredRun = (connection: Database, runId: string): StoredRun | undefined =>
  (connection
    .query(
      `SELECT run_id, start_request_key, workflow_key, workflow_revision, state,
        accepted_at_ms, engine_confirmed_at_ms, updated_at_ms, finalized_at_ms, outcome_summary_json,
        outcome_event_id, parent_run_id, child_invocation_key, suspension_kind, suspension_details_json
       FROM kojo_workflow_runs WHERE run_id = ?`,
    )
    .get(runId) as StoredRun | null) ?? undefined;

const emptyActivitySummary = (): WorkflowRunListItem["activitySummary"] => ({
  invocationAttempts: 0,
  incompleteAttempts: 0,
  retries: 0,
  durableCompletions: 0,
  replayReuses: 0,
});

const readActivitySummary = (
  connection: Database,
  runId: string,
): WorkflowRunListItem["activitySummary"] => {
  const counts = connection
    .query(
      `SELECT
        COUNT(*) AS invocation_attempts,
        COALESCE(SUM(CASE WHEN state != 'engine-confirmed' THEN 1 ELSE 0 END), 0) AS incomplete_attempts,
        COALESCE(SUM(CASE WHEN invocation_number > 1 THEN 1 ELSE 0 END), 0) AS retries,
        COALESCE(SUM(CASE WHEN state = 'engine-confirmed' THEN 1 ELSE 0 END), 0) AS durable_completions
       FROM kojo_workflow_activity_attempts
       WHERE run_id = ?`,
    )
    .get(runId) as {
    readonly durable_completions: number;
    readonly incomplete_attempts: number;
    readonly invocation_attempts: number;
    readonly retries: number;
  } | null;
  if (counts === null) return emptyActivitySummary();
  const replay = connection
    .query(
      "SELECT COUNT(*) AS replay_reuses FROM kojo_execution_events WHERE run_id = ? AND kind = 'activity.result-reused'",
    )
    .get(runId) as { readonly replay_reuses: number } | null;
  return {
    invocationAttempts: counts.invocation_attempts,
    incompleteAttempts: counts.incomplete_attempts,
    retries: counts.retries,
    durableCompletions: counts.durable_completions,
    replayReuses: replay?.replay_reuses ?? 0,
  };
};

const toRunListItem = (connection: Database, row: StoredRun): WorkflowRunListItem => ({
  runId: row.run_id as WorkflowRunListItem["runId"],
  workflowKey: row.workflow_key,
  workflowRevision: row.workflow_revision,
  state: row.state as WorkflowRunListItem["state"],
  acceptedAtMs: row.accepted_at_ms,
  engineConfirmedAtMs: row.engine_confirmed_at_ms,
  updatedAtMs: row.updated_at_ms,
  finalizedAtMs: row.finalized_at_ms,
  parentRunId: row.parent_run_id as WorkflowRunListItem["parentRunId"],
  childInvocationKey: row.child_invocation_key,
  allowedActions:
    row.state === "running"
      ? ["stop"]
      : row.state === "suspended"
        ? [
            ...(row.suspension_kind === "manual"
              ? (["resume"] as const)
              : row.suspension_kind === "deferred"
                ? (["deferred-complete"] as const)
                : []),
            "stop",
          ]
        : [],
  activitySummary: readActivitySummary(connection, row.run_id),
  agentTrace: readAgentTrace(connection, row.run_id),
  sandboxTrace: readSandboxTrace(connection, row.run_id),
});

const readActivityTrace = (
  connection: Database,
  runId: string,
): WorkflowRunSnapshot["activityTrace"] => {
  const attempts = connection
    .query(
      `SELECT attempt_id, durable_operation_key, activity_name, effect_retry_number,
        invocation_number, activity_idempotency_key, state, outcome_code, started_at_ms,
        result_observed_at_ms, engine_confirmed_at_ms
       FROM kojo_workflow_activity_attempts
       WHERE run_id = ?
       ORDER BY started_at_ms ASC, attempt_id ASC`,
    )
    .all(runId) as ReadonlyArray<{
    readonly activity_idempotency_key: string;
    readonly activity_name: string;
    readonly attempt_id: string;
    readonly durable_operation_key: string;
    readonly effect_retry_number: number;
    readonly engine_confirmed_at_ms: number | null;
    readonly invocation_number: number;
    readonly outcome_code: string | null;
    readonly result_observed_at_ms: number | null;
    readonly started_at_ms: number;
    readonly state: "started" | "result-observed" | "engine-confirmed";
  }>;
  return {
    attempts: attempts.map((attempt) => ({
      attemptId: attempt.attempt_id,
      durableOperationKey: attempt.durable_operation_key,
      activityName: attempt.activity_name,
      effectRetryNumber: attempt.effect_retry_number,
      invocationNumber: attempt.invocation_number,
      activityIdempotencyKey: attempt.activity_idempotency_key,
      state: attempt.state,
      outcomeCode: attempt.outcome_code,
      startedAtMs: attempt.started_at_ms,
      resultObservedAtMs: attempt.result_observed_at_ms,
      engineConfirmedAtMs: attempt.engine_confirmed_at_ms,
    })),
    summary: readActivitySummary(connection, runId),
  };
};

const sandboxTraceKinds = new Set<WorkflowSandboxTraceRecord["kind"]>([
  "sandbox.acquired",
  "sandbox.session-recreated",
  "command.completed",
  "command.failed",
  "command.timed-out",
]);

const agentTraceKinds = new Set<WorkflowAgentTraceRecord["kind"]>([
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.session-continued",
  "agent.replayed",
]);

const isSandboxTraceKind = (kind: unknown): kind is WorkflowSandboxTraceRecord["kind"] =>
  typeof kind === "string" && sandboxTraceKinds.has(kind as WorkflowSandboxTraceRecord["kind"]);

const isAgentTraceKind = (kind: unknown): kind is WorkflowAgentTraceRecord["kind"] =>
  typeof kind === "string" && agentTraceKinds.has(kind as WorkflowAgentTraceRecord["kind"]);

const settledBoundaryKind = (
  kind: WorkflowSandboxTraceRecord["kind"] | WorkflowAgentTraceRecord["kind"],
) =>
  kind === "sandbox.acquired" || kind === "sandbox.session-recreated" || kind === "agent.started"
    ? ("boundary.started" as const)
    : ("boundary.completed" as const);

type BoundaryEvidencePayload = {
  readonly artifactIds?: ReadonlyArray<string>;
  readonly durationMs?: number | null;
  readonly evidence?: {
    readonly kind?: unknown;
    readonly source?: unknown;
  };
  readonly exitCode?: number | null;
  readonly operationKey: string;
  readonly providerKind: string;
  readonly sandboxIdentity: string;
};

/**
 * Sandbox and Agent integrations predate the settled ADR 0011 Event catalog.
 * Their source identity stays in the generic Boundary Event body so snapshots
 * retain their public evidence model without introducing undeclared v1 kinds.
 */
const readSandboxTrace = (connection: Database, runId: string) =>
  (
    connection
      .query(
        `SELECT kind, recorded_at_ms, payload_json
       FROM kojo_execution_events
       WHERE run_id = ? AND kind IN (
         'sandbox.acquired', 'sandbox.session-recreated',
         'command.completed', 'command.failed', 'command.timed-out',
         'boundary.started', 'boundary.completed'
       )
       ORDER BY sequence ASC`,
      )
      .all(runId) as ReadonlyArray<{
      readonly kind: string;
      readonly payload_json: string;
      readonly recorded_at_ms: number;
    }>
  ).flatMap((event) => {
    const payload = JSON.parse(event.payload_json) as BoundaryEvidencePayload;
    const kind = isSandboxTraceKind(event.kind)
      ? event.kind
      : payload.evidence?.source === "sandbox" && isSandboxTraceKind(payload.evidence.kind)
        ? payload.evidence.kind
        : undefined;
    return kind === undefined
      ? []
      : [
          {
            artifactIds: [...(payload.artifactIds ?? [])],
            durationMs: payload.durationMs ?? null,
            exitCode: payload.exitCode ?? null,
            kind,
            operationKey: payload.operationKey,
            providerKind: payload.providerKind,
            recordedAtMs: event.recorded_at_ms,
            sandboxIdentity: payload.sandboxIdentity,
          },
        ];
  });

const readAgentTrace = (connection: Database, runId: string) =>
  (
    connection
      .query(
        `SELECT kind, recorded_at_ms, payload_json
         FROM kojo_execution_events
       WHERE run_id = ? AND kind IN (
         'agent.started', 'agent.completed', 'agent.failed',
         'agent.session-continued', 'agent.replayed',
         'boundary.started', 'boundary.completed'
       )
       ORDER BY sequence ASC`,
      )
      .all(runId) as ReadonlyArray<{
      readonly kind: string;
      readonly payload_json: string;
      readonly recorded_at_ms: number;
    }>
  ).flatMap((event) => {
    const payload = JSON.parse(event.payload_json) as BoundaryEvidencePayload;
    const kind = isAgentTraceKind(event.kind)
      ? event.kind
      : payload.evidence?.source === "agent" && isAgentTraceKind(payload.evidence.kind)
        ? payload.evidence.kind
        : undefined;
    return kind === undefined
      ? []
      : [
          {
            artifactIds: [...(payload.artifactIds ?? [])],
            durationMs: payload.durationMs ?? null,
            kind,
            operationKey: payload.operationKey,
            providerKind: payload.providerKind,
            recordedAtMs: event.recorded_at_ms,
            sandboxIdentity: payload.sandboxIdentity,
          },
        ];
  });

const readRunSnapshot = (
  connection: Database,
  runId: string,
): StoredWorkflowRunSnapshot | undefined => {
  const row = readStoredRun(connection, runId);
  if (row === undefined) return undefined;
  const accepted =
    (connection
      .query(
        `SELECT payload_json, payload_sensitivity_map_version, payload_sensitivity_map_json
         FROM kojo_execution_events WHERE run_id = ? AND sequence = 1 AND kind = 'run.accepted'`,
      )
      .get(runId) as {
      readonly payload_json: string;
      readonly payload_sensitivity_map_json: string;
      readonly payload_sensitivity_map_version: number;
    } | null) ?? undefined;
  if (accepted === undefined) throw new Error("Workflow Run is missing its Start Snapshot");
  const outcomeEvent =
    row.outcome_event_id === null
      ? undefined
      : ((connection
          .query(
            `SELECT payload_sensitivity_map_version, payload_sensitivity_map_json
             FROM kojo_execution_events WHERE run_id = ? AND event_id = ?`,
          )
          .get(runId, row.outcome_event_id) as {
          readonly payload_sensitivity_map_json: string;
          readonly payload_sensitivity_map_version: number;
        } | null) ?? undefined);
  return {
    run: {
      ...toRunListItem(connection, row),
      startRequestKey: row.start_request_key as RequestKey,
      startSnapshot: JSON.parse(accepted.payload_json) as WorkflowRunSnapshot["startSnapshot"],
      suspension:
        row.suspension_details_json === null
          ? null
          : (JSON.parse(row.suspension_details_json) as WorkflowRunSuspension),
      outcome:
        row.outcome_summary_json === null
          ? null
          : (JSON.parse(row.outcome_summary_json) as WorkflowRunSnapshot["outcome"]),
      activityTrace: readActivityTrace(connection, runId),
    },
    startSnapshotSensitivityMap: decodeSensitivityMap(
      accepted.payload_sensitivity_map_version,
      accepted.payload_sensitivity_map_json,
    ),
    outcomeSensitivityMap:
      row.outcome_summary_json === null
        ? decodeSensitivityMap(SENSITIVITY_MAP_VERSION, encodeSensitivityMap(sensitivityMap([])))
        : outcomeEvent === undefined
          ? decodeSensitivityMap(undefined, undefined)
          : decodeSensitivityMap(
              outcomeEvent.payload_sensitivity_map_version,
              outcomeEvent.payload_sensitivity_map_json,
            ),
  };
};

const traceFilterSql = (filters: ExecutionTraceFilters, values: Array<string | number>) => {
  const clauses: Array<string> = [];
  const activityNames = filters.activityNames ?? [];
  const artifactConditions = filters.artifactConditions ?? [];
  const boundaryIds = filters.boundaryIds ?? [];
  const eventFamilies = filters.eventFamilies ?? [];
  const occurrenceOutcomes = filters.occurrenceOutcomes ?? [];
  const parentRunIds = filters.parentRunIds ?? [];
  const runStates = filters.runStates ?? [];
  const scheduleKeys = filters.scheduleKeys ?? [];
  const triggerKinds = filters.triggerKinds ?? [];
  const workflowKeys = filters.workflowKeys ?? [];
  const addIn = (column: string, entries: ReadonlyArray<string>) => {
    if (entries.length === 0) return;
    clauses.push(`${column} IN (${entries.map(() => "?").join(", ")})`);
    values.push(...entries);
  };
  const addRunIn = (column: string, entries: ReadonlyArray<string>) => {
    if (entries.length === 0) return;
    clauses.push(
      `run_id IN (SELECT run_id FROM kojo_workflow_runs WHERE ${column} IN (${entries
        .map(() => "?")
        .join(", ")}))`,
    );
    values.push(...entries);
  };
  addIn("kind", filters.kinds);
  addIn("engine_operation_id", filters.engineOperationIds);
  addIn("activity_attempt_id", filters.activityAttemptIds);
  addIn("child_run_id", filters.childRunIds);
  addIn("boundary_id", boundaryIds);
  if (eventFamilies.length > 0) {
    clauses.push(`(${eventFamilies.map(() => "kind LIKE ?").join(" OR ")})`);
    values.push(...eventFamilies.map((family) => `${family}.%`));
  }
  if (activityNames.length > 0) {
    clauses.push(
      `activity_attempt_id IN (SELECT attempt_id FROM kojo_workflow_activity_attempts WHERE activity_name IN (${activityNames
        .map(() => "?")
        .join(", ")}))`,
    );
    values.push(...activityNames);
  }
  if (artifactConditions.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM kojo_execution_event_artifacts event_artifact
         JOIN kojo_execution_artifacts artifact ON artifact.run_id = event_artifact.run_id
          AND artifact.artifact_id = event_artifact.artifact_id
        WHERE event_artifact.run_id = kojo_execution_events.run_id
          AND event_artifact.event_id = kojo_execution_events.event_id
          AND artifact.condition IN (${artifactConditions.map(() => "?").join(", ")}))`,
    );
    values.push(...artifactConditions);
  }
  addRunIn("state", runStates);
  addRunIn("workflow_key", workflowKeys);
  addRunIn("trigger_kind", triggerKinds);
  addRunIn("parent_run_id", parentRunIds);
  addRunIn("schedule_key", scheduleKeys);
  if (occurrenceOutcomes.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM kojo_workflow_schedule_occurrences occurrence
        WHERE occurrence.linked_run_id = kojo_execution_events.run_id
          AND occurrence.outcome IN (${occurrenceOutcomes.map(() => "?").join(", ")}))`,
    );
    values.push(...occurrenceOutcomes);
  }
  if (filters.recordedAfterMs !== undefined) {
    clauses.push("recorded_at_ms >= ?");
    values.push(filters.recordedAfterMs);
  }
  if (filters.recordedBeforeMs !== undefined) {
    clauses.push("recorded_at_ms <= ?");
    values.push(filters.recordedBeforeMs);
  }
  return clauses;
};

/**
 * The database is authoritative for the per-Run sequence. This reader applies
 * only indexed, settled metadata filters; it never parses payload JSON in SQL.
 */
const readStoredExecutionTrace = (
  connection: Database,
  runId: string,
  input: ExecutionTraceRead,
) => {
  const run =
    (connection
      .query("SELECT state, last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
      .get(runId) as {
      readonly last_event_sequence: number;
      readonly state: "running" | "suspended" | "stopping" | "stopped" | "failed" | "completed";
    } | null) ?? undefined;
  if (run === undefined) return undefined;

  const values: Array<string | number> = [runId];
  const clauses = ["run_id = ?", ...traceFilterSql(input.filters, values)];
  if (input.afterSequence !== undefined) {
    clauses.push("sequence > ?");
    values.push(input.afterSequence);
  }
  if (input.beforeSequence !== undefined) {
    clauses.push("sequence < ?");
    values.push(input.beforeSequence);
  }
  const descending = input.beforeSequence !== undefined;
  values.push(input.limit + 1);
  const rows = connection
    .query(
      `SELECT event_id, run_id, sequence, envelope_version, kind, kind_version,
              recorded_at_ms, observed_at_ms, engine_operation_id, activity_attempt_id,
              boundary_id, child_run_id, payload_json, payload_sensitivity_map_version,
              payload_sensitivity_map_json
       FROM kojo_execution_events
       WHERE ${clauses.join(" AND ")}
       ORDER BY sequence ${descending ? "DESC" : "ASC"}
       LIMIT ?`,
    )
    .all(...values) as ReadonlyArray<{
    readonly activity_attempt_id: string | null;
    readonly boundary_id: string | null;
    readonly child_run_id: string | null;
    readonly engine_operation_id: string | null;
    readonly envelope_version: number;
    readonly event_id: string;
    readonly kind: string;
    readonly kind_version: number;
    readonly observed_at_ms: number | null;
    readonly payload_json: string;
    readonly payload_sensitivity_map_json: string;
    readonly payload_sensitivity_map_version: number;
    readonly recorded_at_ms: number;
    readonly run_id: string;
    readonly sequence: number;
  }>;
  const hasMore = rows.length > input.limit;
  const bounded = rows.slice(0, input.limit);
  const ordered = descending ? [...bounded].reverse() : bounded;
  const events: ReadonlyArray<StoredExecutionTraceEvent> = ordered.map((row) => ({
    activityAttemptId: row.activity_attempt_id,
    boundaryId: row.boundary_id,
    childRunId: row.child_run_id,
    engineOperationId: row.engine_operation_id,
    envelopeVersion: row.envelope_version,
    eventId: row.event_id,
    kind: row.kind,
    kindVersion: row.kind_version,
    observedAtMs: row.observed_at_ms,
    payload: JSON.parse(row.payload_json),
    payloadSensitivityMap: decodeSensitivityMap(
      row.payload_sensitivity_map_version,
      row.payload_sensitivity_map_json,
    ),
    recordedAtMs: row.recorded_at_ms,
    runId: row.run_id,
    sequence: row.sequence,
  }));
  return {
    events,
    hasMore,
    highWaterSequence: run.last_event_sequence,
    runState: run.state,
  };
};

const toStoredExecutionArtifact = (row: {
  readonly artifact_id: string;
  readonly byte_size: number;
  readonly condition: "available" | "missing" | "expired";
  readonly created_at_ms: number;
  readonly display_name: string;
  readonly media_type: string;
  readonly sha256: Uint8Array;
  readonly storage_key: string;
  readonly unavailable_at_ms: number | null;
  readonly unavailable_reason_code: string | null;
}): StoredExecutionArtifact => ({
  artifactId: row.artifact_id,
  byteSize: row.byte_size,
  condition: row.condition,
  createdAtMs: row.created_at_ms,
  displayName: row.display_name,
  mediaType: row.media_type,
  sha256: row.sha256,
  storageKey: row.storage_key,
  unavailableAtMs: row.unavailable_at_ms,
  unavailableReasonCode: row.unavailable_reason_code,
});

/** Reads a full export from one durable per-Run high-water mark. */
const exportStoredExecutionTrace = (connection: Database, runId: string) => {
  const run =
    (connection
      .query("SELECT state, last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
      .get(runId) as {
      readonly last_event_sequence: number;
      readonly state: "running" | "suspended" | "stopping" | "stopped" | "failed" | "completed";
    } | null) ?? undefined;
  if (run === undefined) return undefined;
  const rows = connection
    .query(
      `SELECT event_id, run_id, sequence, envelope_version, kind, kind_version,
              recorded_at_ms, observed_at_ms, engine_operation_id, activity_attempt_id,
              boundary_id, child_run_id, payload_json, payload_sensitivity_map_version,
              payload_sensitivity_map_json
       FROM kojo_execution_events
       WHERE run_id = ? AND sequence <= ?
       ORDER BY sequence ASC`,
    )
    .all(runId, run.last_event_sequence) as ReadonlyArray<{
    readonly activity_attempt_id: string | null;
    readonly boundary_id: string | null;
    readonly child_run_id: string | null;
    readonly engine_operation_id: string | null;
    readonly envelope_version: number;
    readonly event_id: string;
    readonly kind: string;
    readonly kind_version: number;
    readonly observed_at_ms: number | null;
    readonly payload_json: string;
    readonly payload_sensitivity_map_json: string;
    readonly payload_sensitivity_map_version: number;
    readonly recorded_at_ms: number;
    readonly run_id: string;
    readonly sequence: number;
  }>;
  const events: ReadonlyArray<StoredExecutionTraceEvent> = rows.map((row) => ({
    activityAttemptId: row.activity_attempt_id,
    boundaryId: row.boundary_id,
    childRunId: row.child_run_id,
    engineOperationId: row.engine_operation_id,
    envelopeVersion: row.envelope_version,
    eventId: row.event_id,
    kind: row.kind,
    kindVersion: row.kind_version,
    observedAtMs: row.observed_at_ms,
    payload: JSON.parse(row.payload_json),
    payloadSensitivityMap: decodeSensitivityMap(
      row.payload_sensitivity_map_version,
      row.payload_sensitivity_map_json,
    ),
    recordedAtMs: row.recorded_at_ms,
    runId: row.run_id,
    sequence: row.sequence,
  }));
  const artifacts = connection
    .query(
      `SELECT DISTINCT artifact.artifact_id, artifact.storage_key, artifact.display_name,
              artifact.media_type, artifact.byte_size, artifact.sha256, artifact.condition,
              artifact.created_at_ms, artifact.unavailable_at_ms, artifact.unavailable_reason_code
       FROM kojo_execution_artifacts artifact
       JOIN kojo_execution_event_artifacts event_artifact
         ON event_artifact.run_id = artifact.run_id
        AND event_artifact.artifact_id = artifact.artifact_id
       JOIN kojo_execution_events event ON event.event_id = event_artifact.event_id
        AND event.run_id = event_artifact.run_id
       WHERE artifact.run_id = ? AND event.sequence <= ?
       ORDER BY artifact.created_at_ms ASC, artifact.artifact_id ASC`,
    )
    .all(runId, run.last_event_sequence) as ReadonlyArray<
    Parameters<typeof toStoredExecutionArtifact>[0]
  >;
  return {
    artifacts: artifacts.map(toStoredExecutionArtifact),
    events,
    highWaterSequence: run.last_event_sequence,
    runState: run.state,
  };
};

/** Keep writes on the same closed v1 catalog that readers advertise. */
const executionEventKindsV1 = new Set<string>(EXECUTION_EVENT_KINDS_V1);

const appendEvent = (
  connection: Database,
  options: {
    readonly activityAttemptId?: string;
    readonly boundaryId?: string;
    readonly engineOperationId?: string;
    readonly eventId: string;
    readonly kind: string;
    readonly childRunId?: string;
    readonly payload: unknown;
    readonly sensitivityMap: SensitivityMap;
    readonly recordedAtMs: number;
    readonly runId: string;
    readonly sequence: number;
  },
) => {
  if (!executionEventKindsV1.has(options.kind)) {
    throw new Error(`Unsupported Execution Event v1 kind: ${options.kind}`);
  }
  const payloadJson = JSON.stringify(options.payload);
  connection
    .query(
      `INSERT INTO kojo_execution_events(
        event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms,
        engine_operation_id, activity_attempt_id, boundary_id, child_run_id,
        payload_encoding_version, payload_schema_identity, payload_json,
        payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256
      ) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?, 1, 'kojo.workflow-run-event/v1', ?, ?, ?, ?)`,
    )
    .run(
      options.eventId,
      options.runId,
      options.sequence,
      options.kind,
      options.recordedAtMs,
      options.engineOperationId ?? null,
      options.activityAttemptId ?? null,
      options.boundaryId ?? null,
      options.childRunId ?? null,
      payloadJson,
      SENSITIVITY_MAP_VERSION,
      encodeSensitivityMap(options.sensitivityMap),
      hash(payloadJson),
    );
};

export const DrizzleWorkflowScheduleRepositoryLive = Layer.sync(WorkflowScheduleRepository, () => ({
  reconcile: (project, definitions, appliedAtMs, nextOccurrence) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const appliedAt = safeTimestamp(appliedAtMs);
          const current = new Map(
            (connection.query(scheduleSelect).all() as ReadonlyArray<StoredSchedule>).map((row) => [
              row.schedule_key,
              row,
            ]),
          );
          const declared = new Set<string>();
          for (const rawDefinition of definitions) {
            const definition = toScheduleDefinition(rawDefinition);
            declared.add(definition.scheduleKey);
            const existing = current.get(definition.scheduleKey);
            if (existing === undefined) {
              connection
                .query(
                  `INSERT INTO kojo_workflow_schedule_states(
                      schedule_key, enabled_intent, condition,
                      current_workflow_key, current_revision, current_cron, current_time_zone,
                      current_overlap_policy, current_input_rule_revision,
                      applied_workflow_key, applied_revision, applied_cron, applied_time_zone,
                      applied_overlap_policy, applied_input_rule_revision,
                      row_version, created_at_ms, updated_at_ms
                    ) VALUES (?, 0, 'available', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
                )
                .run(
                  definition.scheduleKey,
                  definition.workflowKey,
                  definition.revision,
                  definition.cron,
                  definition.timeZone,
                  definition.overlapPolicy,
                  definition.inputRuleRevision,
                  definition.workflowKey,
                  definition.revision,
                  definition.cron,
                  definition.timeZone,
                  definition.overlapPolicy,
                  definition.inputRuleRevision,
                  appliedAt,
                  appliedAt,
                );
              continue;
            }
            const changed = !sameScheduleDefinition(existing, definition);
            const restored = existing.condition === "unavailable";
            const repaired = existing.condition === "needs-attention" && changed;
            const needsNext =
              existing.enabled_intent === 1 &&
              (changed ||
                restored ||
                repaired ||
                (existing.condition === "available" && existing.next_occurrence_ms === null));
            if (!changed && !restored && !repaired && !needsNext) continue;
            let invalidatedThrough = 0;
            if (changed) {
              const planned = connection
                .query(
                  `SELECT MAX(scheduled_at_ms) AS scheduled_at_ms
                   FROM kojo_workflow_schedule_occurrences
                   WHERE schedule_key = ? AND outcome = 'planned'`,
                )
                .get(definition.scheduleKey) as { readonly scheduled_at_ms: number | null } | null;
              invalidatedThrough = planned?.scheduled_at_ms ?? 0;
              connection
                .query(
                  `UPDATE kojo_workflow_schedule_occurrences
                     SET outcome = 'invalidated', reason_code = 'schedule.definition-changed',
                       processed_at_ms = ?, row_version = row_version + 1
                   WHERE schedule_key = ? AND outcome = 'planned'`,
                )
                .run(appliedAt, definition.scheduleKey);
            }
            const strictlyAfter = Math.max(
              appliedAt,
              existing.high_water_mark_ms ?? 0,
              invalidatedThrough,
            );
            const next =
              existing.enabled_intent === 1 ? nextOccurrence(definition, strictlyAfter) : null;
            connection
              .query(
                `UPDATE kojo_workflow_schedule_states
                   SET condition = 'available', condition_reason_code = NULL,
                     current_workflow_key = ?, current_revision = ?, current_cron = ?,
                     current_time_zone = ?, current_overlap_policy = ?, current_input_rule_revision = ?,
                     applied_workflow_key = ?, applied_revision = ?, applied_cron = ?,
                     applied_time_zone = ?, applied_overlap_policy = ?, applied_input_rule_revision = ?,
                     next_occurrence_ms = ?, row_version = row_version + 1, updated_at_ms = ?
                   WHERE schedule_key = ?`,
              )
              .run(
                definition.workflowKey,
                definition.revision,
                definition.cron,
                definition.timeZone,
                definition.overlapPolicy,
                definition.inputRuleRevision,
                definition.workflowKey,
                definition.revision,
                definition.cron,
                definition.timeZone,
                definition.overlapPolicy,
                definition.inputRuleRevision,
                next,
                appliedAt,
                definition.scheduleKey,
              );
          }
          for (const [scheduleKey, existing] of current) {
            if (declared.has(scheduleKey)) continue;
            if (
              existing.current_revision === null &&
              existing.condition === "unavailable" &&
              existing.next_occurrence_ms === null
            ) {
              continue;
            }
            connection
              .query(
                `UPDATE kojo_workflow_schedule_states
                   SET condition = 'unavailable', condition_reason_code = 'schedule.definition-unavailable',
                     current_workflow_key = NULL, current_revision = NULL, current_cron = NULL,
                     current_time_zone = NULL, current_overlap_policy = NULL,
                     current_input_rule_revision = NULL, next_occurrence_ms = NULL,
                     row_version = row_version + 1, updated_at_ms = ?
                   WHERE schedule_key = ?`,
              )
              .run(appliedAt, scheduleKey);
            connection
              .query(
                `UPDATE kojo_workflow_schedule_occurrences
                   SET outcome = 'invalidated', reason_code = 'schedule.definition-unavailable',
                     processed_at_ms = ?, row_version = row_version + 1
                 WHERE schedule_key = ? AND outcome = 'planned'`,
              )
              .run(appliedAt, scheduleKey);
          }
          return listStoredSchedules(connection);
        }),
      ),
    ),
  list: (project, input) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        listStoredSchedules(connection).filter(
          (schedule) =>
            (input.workflowKeys.length === 0 ||
              (schedule.definition !== null &&
                input.workflowKeys.includes(schedule.definition.workflowKey))) &&
            (input.conditions.length === 0 || input.conditions.includes(schedule.condition)),
        ),
      ),
    ),
  show: (project, scheduleKey) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        const schedule = readStoredSchedule(connection, scheduleKey);
        return schedule === undefined ? undefined : toScheduleSnapshot(schedule);
      }),
    ),
  enable: (input) =>
    Effect.sync(() =>
      withWritableProjectStore(input.project, (connection) =>
        transaction(connection, () => {
          const existingReceipt =
            (connection
              .query(
                "SELECT operation_kind, request_sha256, target_schedule_key FROM kojo_control_requests WHERE request_key = ?",
              )
              .get(input.requestKey) as {
              readonly operation_kind: string;
              readonly request_sha256: Uint8Array;
              readonly target_schedule_key: string | null;
            } | null) ?? undefined;
          if (existingReceipt !== undefined) {
            if (
              existingReceipt.operation_kind !== "schedule.enable" ||
              !sameBytes(existingReceipt.request_sha256, input.requestHash) ||
              existingReceipt.target_schedule_key !== input.scheduleKey
            ) {
              return { _tag: "request-key-conflict" as const };
            }
            const replayed = readStoredSchedule(connection, input.scheduleKey);
            if (replayed === undefined) return { _tag: "schedule-not-found" as const };
            return {
              _tag: "accepted" as const,
              alreadyApplied: true,
              schedule: toScheduleSnapshot(replayed),
            };
          }
          const schedule = readStoredSchedule(connection, input.scheduleKey);
          if (schedule === undefined || currentScheduleDefinition(schedule) === null) {
            return { _tag: "schedule-not-found" as const };
          }
          const definition = currentScheduleDefinition(schedule) as WorkflowScheduleDefinition;
          if (definition.revision !== input.scheduleRevision) {
            return {
              _tag: "schedule-revision-conflict" as const,
              schedule: toScheduleSnapshot(schedule),
            };
          }
          const acceptedAt = safeTimestamp(input.acceptedAtMs);
          const next =
            schedule.enabled_intent === 1 && schedule.next_occurrence_ms !== null
              ? schedule.next_occurrence_ms
              : input.nextOccurrence(
                  definition,
                  Math.max(acceptedAt, schedule.high_water_mark_ms ?? 0),
                );
          connection
            .query(
              `UPDATE kojo_workflow_schedule_states
                 SET enabled_intent = 1, next_occurrence_ms = ?, row_version = row_version + 1,
                   updated_at_ms = ? WHERE schedule_key = ?`,
            )
            .run(next, acceptedAt, input.scheduleKey);
          insertScheduleReceipt(connection, {
            acceptedAtMs: acceptedAt,
            operationKind: "schedule.enable",
            requestHash: input.requestHash,
            requestKey: input.requestKey,
            scheduleKey: input.scheduleKey,
          });
          const enabled = readStoredSchedule(connection, input.scheduleKey);
          if (enabled === undefined) throw new Error("Workflow Schedule disappeared after enable");
          return {
            _tag: "accepted" as const,
            alreadyApplied: false,
            schedule: toScheduleSnapshot(enabled),
          };
        }),
      ),
    ),
  disable: (input) =>
    Effect.sync(() =>
      withWritableProjectStore(input.project, (connection) =>
        transaction(connection, () => {
          const existingReceipt =
            (connection
              .query(
                "SELECT operation_kind, request_sha256, target_schedule_key FROM kojo_control_requests WHERE request_key = ?",
              )
              .get(input.requestKey) as {
              readonly operation_kind: string;
              readonly request_sha256: Uint8Array;
              readonly target_schedule_key: string | null;
            } | null) ?? undefined;
          if (existingReceipt !== undefined) {
            if (
              existingReceipt.operation_kind !== "schedule.disable" ||
              !sameBytes(existingReceipt.request_sha256, input.requestHash) ||
              existingReceipt.target_schedule_key !== input.scheduleKey
            ) {
              return { _tag: "request-key-conflict" as const };
            }
            const replayed = readStoredSchedule(connection, input.scheduleKey);
            if (replayed === undefined) return { _tag: "schedule-not-found" as const };
            return {
              _tag: "accepted" as const,
              alreadyApplied: true,
              schedule: toScheduleSnapshot(replayed),
            };
          }
          const schedule = readStoredSchedule(connection, input.scheduleKey);
          if (schedule === undefined) return { _tag: "schedule-not-found" as const };
          const acceptedAt = safeTimestamp(input.acceptedAtMs);
          connection
            .query(
              `UPDATE kojo_workflow_schedule_states
                 SET enabled_intent = 0, next_occurrence_ms = NULL, row_version = row_version + 1,
                   updated_at_ms = ? WHERE schedule_key = ?`,
            )
            .run(acceptedAt, input.scheduleKey);
          connection
            .query(
              `UPDATE kojo_workflow_schedule_occurrences
                 SET outcome = 'invalidated', reason_code = 'schedule.disabled', processed_at_ms = ?,
                   row_version = row_version + 1
               WHERE schedule_key = ? AND outcome = 'planned'`,
            )
            .run(acceptedAt, input.scheduleKey);
          insertScheduleReceipt(connection, {
            acceptedAtMs: acceptedAt,
            operationKind: "schedule.disable",
            requestHash: input.requestHash,
            requestKey: input.requestKey,
            scheduleKey: input.scheduleKey,
          });
          const disabled = readStoredSchedule(connection, input.scheduleKey);
          if (disabled === undefined)
            throw new Error("Workflow Schedule disappeared after disable");
          return {
            _tag: "accepted" as const,
            alreadyApplied: false,
            schedule: toScheduleSnapshot(disabled),
          };
        }),
      ),
    ),
  planOccurrence: (input) =>
    Effect.sync(() =>
      withWritableProjectStore(input.project, (connection) =>
        transaction(connection, () => {
          const schedule = readStoredSchedule(connection, input.scheduleKey);
          if (
            schedule === undefined ||
            schedule.enabled_intent !== 1 ||
            schedule.condition !== "available" ||
            schedule.applied_revision !== input.appliedRevision ||
            schedule.next_occurrence_ms !== input.scheduledAtMs
          ) {
            return undefined;
          }
          const existing = readStoredOccurrence(connection, input.scheduleKey, input.scheduledAtMs);
          if (existing !== undefined) return toOccurrenceSnapshot(existing);
          const plannedAt = safeTimestamp(input.plannedAtMs);
          const inputJson = JSON.stringify(input.input);
          connection
            .query(
              `INSERT INTO kojo_workflow_schedule_occurrences(
                schedule_key, scheduled_at_ms, applied_revision, resolved_input_encoding_version,
                resolved_input_schema_identity, resolved_input_json,
                resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json,
                resolved_input_sha256, outcome, delivery_attempt_count, planned_at_ms, row_version
              ) VALUES (?, ?, ?, 1, 'kojo.workflow-schedule-input/v1', ?, ?, ?, ?, 'planned', 0, ?, 1)`,
            )
            .run(
              input.scheduleKey,
              input.scheduledAtMs,
              input.appliedRevision,
              inputJson,
              SENSITIVITY_MAP_VERSION,
              encodeSensitivityMap(sensitivityMap(input.inputSensitivityPaths)),
              hash(inputJson),
              plannedAt,
            );
          const planned = readStoredOccurrence(connection, input.scheduleKey, input.scheduledAtMs);
          if (planned === undefined) throw new Error("Workflow Schedule Occurrence was not stored");
          return toOccurrenceSnapshot(planned);
        }),
      ),
    ),
  reconcileDueOccurrence: (input) =>
    Effect.sync(() =>
      withWritableProjectStore(input.project, (connection) =>
        transaction(connection, () => {
          const schedule = readStoredSchedule(connection, input.scheduleKey);
          const definition = schedule === undefined ? null : currentScheduleDefinition(schedule);
          if (
            schedule === undefined ||
            definition === null ||
            schedule.enabled_intent !== 1 ||
            schedule.condition !== "available" ||
            schedule.next_occurrence_ms === null
          ) {
            return schedule === undefined ? undefined : toScheduleSnapshot(schedule);
          }
          const observedAt = safeTimestamp(input.observedAtMs);
          if (schedule.next_occurrence_ms > observedAt) return toScheduleSnapshot(schedule);

          const firstMissedAt = schedule.next_occurrence_ms;
          let latestDueAt = firstMissedAt;
          let lastOlderMissedAt: number | undefined;
          let olderMissedCount = 0;
          for (;;) {
            const followingAt = input.nextOccurrence(definition, latestDueAt);
            if (followingAt > observedAt) break;
            lastOlderMissedAt = latestDueAt;
            olderMissedCount += 1;
            latestDueAt = followingAt;
          }
          if (olderMissedCount === 0) return toScheduleSnapshot(schedule);
          if (lastOlderMissedAt === undefined) {
            throw new Error("Workflow Schedule missed range has no final instant");
          }

          const existing = readStoredOccurrence(connection, input.scheduleKey, firstMissedAt);
          if (existing?.outcome === "planned") {
            connection
              .query(
                `UPDATE kojo_workflow_schedule_occurrences
                   SET outcome = 'skipped', reason_code = 'schedule.missed-range',
                     processed_at_ms = ?, missed_range_count = ?,
                     missed_range_last_scheduled_at_ms = ?, row_version = row_version + 1
                   WHERE schedule_key = ? AND scheduled_at_ms = ? AND outcome = 'planned'`,
              )
              .run(
                observedAt,
                olderMissedCount,
                lastOlderMissedAt,
                input.scheduleKey,
                firstMissedAt,
              );
          } else if (existing === undefined) {
            const inputJson = "null";
            connection
              .query(
                `INSERT INTO kojo_workflow_schedule_occurrences(
                  schedule_key, scheduled_at_ms, applied_revision, resolved_input_encoding_version,
                  resolved_input_schema_identity, resolved_input_json,
                  resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json,
                  resolved_input_sha256, outcome, reason_code, delivery_attempt_count,
                  planned_at_ms, processed_at_ms, missed_range_count,
                  missed_range_last_scheduled_at_ms, row_version
                ) VALUES (?, ?, ?, 1, 'kojo.workflow-schedule-input/v1', ?, ?, ?, ?, 'skipped',
                  'schedule.missed-range', 0, ?, ?, ?, ?, 1)`,
              )
              .run(
                input.scheduleKey,
                firstMissedAt,
                definition.revision,
                inputJson,
                SENSITIVITY_MAP_VERSION,
                encodeSensitivityMap(sensitivityMap([])),
                hash(inputJson),
                observedAt,
                observedAt,
                olderMissedCount,
                lastOlderMissedAt,
              );
          } else {
            return toScheduleSnapshot(schedule);
          }
          connection
            .query(
              `UPDATE kojo_workflow_schedule_states
                 SET high_water_mark_ms = ?, next_occurrence_ms = ?,
                   row_version = row_version + 1, updated_at_ms = ?
               WHERE schedule_key = ?`,
            )
            .run(lastOlderMissedAt, latestDueAt, observedAt, input.scheduleKey);
          const reconciled = readStoredSchedule(connection, input.scheduleKey);
          if (reconciled === undefined)
            throw new Error("Workflow Schedule disappeared after downtime");
          return toScheduleSnapshot(reconciled);
        }),
      ),
    ),
  skipOccurrenceIfOverlapping: (input) =>
    Effect.sync(() =>
      withWritableProjectStore(input.project, (connection) =>
        transaction(connection, () => {
          const schedule = readStoredSchedule(connection, input.scheduleKey);
          const definition = schedule === undefined ? null : currentScheduleDefinition(schedule);
          if (
            schedule === undefined ||
            definition === null ||
            definition.overlapPolicy !== "skip" ||
            schedule.enabled_intent !== 1 ||
            schedule.condition !== "available" ||
            schedule.applied_revision !== input.appliedRevision ||
            schedule.next_occurrence_ms !== input.scheduledAtMs
          ) {
            return undefined;
          }
          const active = connection
            .query(
              `SELECT run_id FROM kojo_workflow_runs
               WHERE trigger_kind = 'schedule' AND schedule_key = ?
                 AND state IN ('running', 'suspended', 'stopping')
               LIMIT 1`,
            )
            .get(input.scheduleKey);
          if (active === null || active === undefined) return undefined;
          const processedAt = safeTimestamp(input.processedAtMs);
          connection
            .query(
              `UPDATE kojo_workflow_schedule_occurrences
                 SET outcome = 'skipped', reason_code = 'schedule.overlap', processed_at_ms = ?,
                   row_version = row_version + 1
               WHERE schedule_key = ? AND scheduled_at_ms = ? AND outcome = 'planned'`,
            )
            .run(processedAt, input.scheduleKey, input.scheduledAtMs);
          connection
            .query(
              `UPDATE kojo_workflow_schedule_states
                 SET high_water_mark_ms = ?, next_occurrence_ms = ?,
                   row_version = row_version + 1, updated_at_ms = ?
               WHERE schedule_key = ?`,
            )
            .run(input.scheduledAtMs, input.nextOccurrenceMs, processedAt, input.scheduleKey);
          const skipped = readStoredSchedule(connection, input.scheduleKey);
          if (skipped === undefined) throw new Error("Workflow Schedule disappeared after overlap");
          return toScheduleSnapshot(skipped);
        }),
      ),
    ),
  failOccurrence: (input) =>
    Effect.sync(() =>
      withWritableProjectStore(input.project, (connection) =>
        transaction(connection, () => {
          const schedule = readStoredSchedule(connection, input.scheduleKey);
          if (
            schedule === undefined ||
            schedule.enabled_intent !== 1 ||
            schedule.condition !== "available" ||
            schedule.applied_revision !== input.appliedRevision ||
            schedule.next_occurrence_ms !== input.scheduledAtMs
          ) {
            return schedule === undefined ? undefined : toScheduleSnapshot(schedule);
          }
          const processedAt = safeTimestamp(input.processedAtMs);
          const occurrence = readStoredOccurrence(
            connection,
            input.scheduleKey,
            input.scheduledAtMs,
          );
          if (occurrence?.outcome === "planned") {
            connection
              .query(
                `UPDATE kojo_workflow_schedule_occurrences
                   SET outcome = 'failed', reason_code = ?, processed_at_ms = ?,
                     row_version = row_version + 1
                 WHERE schedule_key = ? AND scheduled_at_ms = ? AND outcome = 'planned'`,
              )
              .run(input.reasonCode, processedAt, input.scheduleKey, input.scheduledAtMs);
          } else if (occurrence === undefined) {
            const inputJson = "null";
            connection
              .query(
                `INSERT INTO kojo_workflow_schedule_occurrences(
                  schedule_key, scheduled_at_ms, applied_revision, resolved_input_encoding_version,
                  resolved_input_schema_identity, resolved_input_json,
                  resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json,
                  resolved_input_sha256, outcome, reason_code, delivery_attempt_count,
                  planned_at_ms, processed_at_ms, row_version
                ) VALUES (?, ?, ?, 1, 'kojo.workflow-schedule-input/v1', ?, ?, ?, ?, 'failed', ?,
                  0, ?, ?, 1)`,
              )
              .run(
                input.scheduleKey,
                input.scheduledAtMs,
                input.appliedRevision,
                inputJson,
                SENSITIVITY_MAP_VERSION,
                encodeSensitivityMap(sensitivityMap([])),
                hash(inputJson),
                input.reasonCode,
                processedAt,
                processedAt,
              );
          } else {
            return toScheduleSnapshot(schedule);
          }
          connection
            .query(
              `UPDATE kojo_workflow_schedule_states
                 SET condition = 'needs-attention', condition_reason_code = ?,
                   high_water_mark_ms = ?, next_occurrence_ms = NULL,
                   row_version = row_version + 1, updated_at_ms = ?
               WHERE schedule_key = ?`,
            )
            .run(input.reasonCode, input.scheduledAtMs, processedAt, input.scheduleKey);
          const failed = readStoredSchedule(connection, input.scheduleKey);
          if (failed === undefined) throw new Error("Workflow Schedule disappeared after failure");
          return toScheduleSnapshot(failed);
        }),
      ),
    ),
  advanceAfterStart: (input) =>
    Effect.sync(() =>
      withWritableProjectStore(input.project, (connection) =>
        transaction(connection, () => {
          const schedule = readStoredSchedule(connection, input.scheduleKey);
          if (
            schedule === undefined ||
            schedule.enabled_intent !== 1 ||
            schedule.condition !== "available" ||
            schedule.applied_revision !== input.appliedRevision ||
            schedule.next_occurrence_ms !== input.scheduledAtMs
          ) {
            return schedule === undefined ? undefined : toScheduleSnapshot(schedule);
          }
          const advancedAt = safeTimestamp(input.advancedAtMs);
          connection
            .query(
              `UPDATE kojo_workflow_schedule_states
                 SET high_water_mark_ms = ?, next_occurrence_ms = ?, row_version = row_version + 1,
                   updated_at_ms = ?
               WHERE schedule_key = ?`,
            )
            .run(input.scheduledAtMs, input.nextOccurrenceMs, advancedAt, input.scheduleKey);
          const advanced = readStoredSchedule(connection, input.scheduleKey);
          if (advanced === undefined) throw new Error("Workflow Schedule disappeared after start");
          return toScheduleSnapshot(advanced);
        }),
      ),
    ),
  listOccurrences: (project, input) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        const clauses: Array<string> = [];
        const parameters: Array<string | number> = [];
        if (input.scheduleKeys.length > 0) {
          clauses.push(`schedule_key IN (${input.scheduleKeys.map(() => "?").join(", ")})`);
          parameters.push(...input.scheduleKeys);
        }
        if (input.outcomes.length > 0) {
          clauses.push(`outcome IN (${input.outcomes.map(() => "?").join(", ")})`);
          parameters.push(...input.outcomes);
        }
        parameters.push(input.limit);
        const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
        const rows = connection
          .query(
            `${occurrenceSelect} ${where} ORDER BY scheduled_at_ms DESC, schedule_key ASC LIMIT ?`,
          )
          .all(...parameters) as ReadonlyArray<StoredOccurrence>;
        return rows.map(toOccurrenceSnapshot);
      }),
    ),
  showOccurrence: (project, scheduleKey, scheduledAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        const occurrence = readStoredOccurrence(connection, scheduleKey, scheduledAtMs);
        return occurrence === undefined ? undefined : toOccurrenceSnapshot(occurrence);
      }),
    ),
}));
const nextEventSequence = (connection: Database, runId: string) =>
  (
    connection
      .query("SELECT last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
      .get(runId) as { readonly last_event_sequence: number }
  ).last_event_sequence + 1;

const advanceRunTrace = (
  connection: Database,
  runId: string,
  sequence: number,
  updatedAtMs: number,
) => {
  connection
    .query(
      `UPDATE kojo_workflow_runs
       SET last_event_sequence = ?, row_version = row_version + 1, updated_at_ms = ?
       WHERE run_id = ?`,
    )
    .run(sequence, updatedAtMs, runId);
};

const appendParentChildEvidence = (
  connection: Database,
  child: StoredRun,
  kind: "child.linked" | "child.finished",
  recordedAtMs: number,
  outcome?: "completed" | "failed" | "stopped",
) => {
  if (child.parent_run_id === null || child.child_invocation_key === null) return;
  const existing = connection
    .query(
      `SELECT event_id FROM kojo_execution_events
       WHERE run_id = ? AND kind = ? AND child_run_id = ? LIMIT 1`,
    )
    .get(child.parent_run_id, kind, child.run_id) as { readonly event_id: string } | null;
  if (existing !== null) return;
  const sequence = nextEventSequence(connection, child.parent_run_id);
  appendEvent(connection, {
    eventId: randomUUID(),
    kind,
    childRunId: child.run_id,
    payload: {
      invocationKey: child.child_invocation_key,
      runId: child.run_id,
      workflowKey: child.workflow_key,
      ...(outcome === undefined ? {} : { outcome }),
    },
    recordedAtMs,
    runId: child.parent_run_id,
    sequence,
    sensitivityMap: sensitivityMap([]),
  });
  advanceRunTrace(connection, child.parent_run_id, sequence, recordedAtMs);
};

export const DrizzleWorkflowRunRepositoryLive = Layer.sync(WorkflowRunRepository, () => ({
  acceptManualStart: (start: WorkflowRunStartRecord) =>
    Effect.sync(() =>
      withWritableProjectStore(start.project, (connection) =>
        transaction(connection, () => {
          const existing =
            (connection
              .query(
                "SELECT operation_kind, request_sha256, target_run_id FROM kojo_control_requests WHERE request_key = ?",
              )
              .get(start.requestKey) as {
              readonly operation_kind: string;
              readonly request_sha256: Uint8Array;
              readonly target_run_id: string | null;
            } | null) ?? undefined;
          if (existing !== undefined) {
            if (
              existing.operation_kind !== "run.start" ||
              !sameBytes(existing.request_sha256, start.requestHash) ||
              existing.target_run_id === null
            ) {
              return { _tag: "request-key-conflict" as const };
            }
            const run = readRunSnapshot(connection, existing.target_run_id);
            if (run === undefined)
              throw new Error("Workflow Run start receipt has no Workflow Run");
            return { _tag: "accepted" as const, run, alreadyApplied: true };
          }

          const engineReferenceJson = JSON.stringify({
            kind: "effect-workflow",
            runId: start.runId,
            workflowKey: start.workflowKey,
            workflowRevision: start.workflowRevision,
          });
          const operationJson = JSON.stringify({
            input: start.encodedInput,
            workflowKey: start.workflowKey,
            workflowRevision: start.workflowRevision,
          });
          const resultJson = JSON.stringify({ runId: start.runId });
          const eventId = randomUUID();
          const operationId = randomUUID();

          connection
            .query(
              `INSERT INTO kojo_workflow_runs(
                run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
                engine_reference_version, engine_reference_json, engine_reference_sha256,
                trigger_kind, state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'manual', 'running', 1, 1, ?, ?)`,
            )
            .run(
              start.runId,
              start.requestKey,
              start.requestHash,
              start.workflowKey,
              start.workflowRevision,
              engineReferenceJson,
              hash(engineReferenceJson),
              start.acceptedAtMs,
              start.acceptedAtMs,
            );
          connection
            .query(
              `INSERT INTO kojo_control_requests(
                request_key, operation_kind, request_sha256, target_kind, target_run_id, state,
                result_encoding_version, result_schema_identity, result_json,
                result_sensitivity_map_version, result_sensitivity_map_json, result_sha256,
                created_at_ms, completed_at_ms
              ) VALUES (?, 'run.start', ?, 'run', ?, 'completed', 1, 'kojo.workflow-run-start/v1', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              start.requestKey,
              start.requestHash,
              start.runId,
              resultJson,
              SENSITIVITY_MAP_VERSION,
              encodeSensitivityMap(sensitivityMap([])),
              hash(resultJson),
              start.acceptedAtMs,
              start.acceptedAtMs,
            );
          appendEvent(connection, {
            eventId,
            kind: "run.accepted",
            payload: start.startSnapshot,
            recordedAtMs: start.acceptedAtMs,
            runId: start.runId,
            sequence: 1,
            sensitivityMap: prefixedSensitivityMap("input", start.inputSensitivityPaths),
          });
          connection
            .query(
              `INSERT INTO kojo_engine_operations(
                operation_id, run_id, kind, operation_key, request_encoding_version,
                request_schema_identity, request_json, request_sensitivity_map_version,
                request_sensitivity_map_json, request_sha256, state, attempt_count,
                next_attempt_at_ms, created_at_ms, updated_at_ms
              ) VALUES (?, ?, 'submit', 'initial', 1, 'kojo.workflow-run-submit/v1', ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
            )
            .run(
              operationId,
              start.runId,
              operationJson,
              SENSITIVITY_MAP_VERSION,
              encodeSensitivityMap(prefixedSensitivityMap("input", start.inputSensitivityPaths)),
              hash(operationJson),
              start.acceptedAtMs,
              start.acceptedAtMs,
              start.acceptedAtMs,
            );
          const run = readRunSnapshot(connection, start.runId);
          if (run === undefined) throw new Error("Workflow Run was not stored");
          return { _tag: "accepted" as const, run, alreadyApplied: false };
        }),
      ),
    ),
  acceptScheduledStart: (start: WorkflowRunScheduleStartRecord) =>
    Effect.sync(() =>
      withWritableProjectStore(start.project, (connection) =>
        transaction(connection, () => {
          const occurrence = readStoredOccurrence(
            connection,
            start.scheduleKey,
            start.scheduledAtMs,
          );
          if (occurrence === undefined || occurrence.outcome !== "planned") {
            if (occurrence?.outcome === "started" && occurrence.linked_run_id !== null) {
              const run = readRunSnapshot(connection, occurrence.linked_run_id);
              if (run === undefined)
                throw new Error("Started Workflow Schedule Occurrence has no Run");
              return { _tag: "accepted" as const, run, alreadyApplied: true };
            }
            return { _tag: "occurrence-not-planned" as const };
          }
          if (occurrence.applied_revision !== start.scheduleRevision) {
            return { _tag: "occurrence-not-planned" as const };
          }
          const existing =
            (connection
              .query(
                "SELECT run_id, start_request_sha256 FROM kojo_workflow_runs WHERE start_request_key = ?",
              )
              .get(start.requestKey) as {
              readonly run_id: string;
              readonly start_request_sha256: Uint8Array;
            } | null) ?? undefined;
          if (existing !== undefined) {
            if (!sameBytes(existing.start_request_sha256, start.requestHash)) {
              return { _tag: "request-key-conflict" as const };
            }
            const run = readRunSnapshot(connection, existing.run_id);
            if (run === undefined) throw new Error("Workflow Run start has no Workflow Run");
            connection
              .query(
                `UPDATE kojo_workflow_schedule_occurrences
                   SET outcome = 'started', linked_run_id = ?, first_attempted_at_ms = COALESCE(first_attempted_at_ms, ?),
                     processed_at_ms = COALESCE(processed_at_ms, ?), delivery_attempt_count = delivery_attempt_count + 1,
                     row_version = row_version + 1
                 WHERE schedule_key = ? AND scheduled_at_ms = ? AND outcome = 'planned'`,
              )
              .run(
                existing.run_id,
                start.acceptedAtMs,
                start.acceptedAtMs,
                start.scheduleKey,
                start.scheduledAtMs,
              );
            return { _tag: "accepted" as const, run, alreadyApplied: true };
          }

          const engineReferenceJson = JSON.stringify({
            kind: "effect-workflow",
            runId: start.runId,
            workflowKey: start.workflowKey,
            workflowRevision: start.workflowRevision,
          });
          const operationJson = JSON.stringify({
            input: start.encodedInput,
            workflowKey: start.workflowKey,
            workflowRevision: start.workflowRevision,
          });
          const eventId = randomUUID();
          const operationId = randomUUID();
          connection
            .query(
              `INSERT INTO kojo_workflow_runs(
                run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
                engine_reference_version, engine_reference_json, engine_reference_sha256,
                trigger_kind, schedule_key, scheduled_at_ms, schedule_revision, state,
                last_event_sequence, row_version, accepted_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'schedule', ?, ?, ?, 'running', 1, 1, ?, ?)`,
            )
            .run(
              start.runId,
              start.requestKey,
              start.requestHash,
              start.workflowKey,
              start.workflowRevision,
              engineReferenceJson,
              hash(engineReferenceJson),
              start.scheduleKey,
              start.scheduledAtMs,
              start.scheduleRevision,
              start.acceptedAtMs,
              start.acceptedAtMs,
            );
          appendEvent(connection, {
            eventId,
            kind: "run.accepted",
            payload: start.startSnapshot,
            recordedAtMs: start.acceptedAtMs,
            runId: start.runId,
            sequence: 1,
            sensitivityMap: prefixedSensitivityMap("input", start.inputSensitivityPaths),
          });
          connection
            .query(
              `INSERT INTO kojo_engine_operations(
                operation_id, run_id, kind, operation_key, request_encoding_version,
                request_schema_identity, request_json, request_sensitivity_map_version,
                request_sensitivity_map_json, request_sha256, state, attempt_count,
                next_attempt_at_ms, created_at_ms, updated_at_ms
              ) VALUES (?, ?, 'submit', 'initial', 1, 'kojo.workflow-run-submit/v1', ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
            )
            .run(
              operationId,
              start.runId,
              operationJson,
              SENSITIVITY_MAP_VERSION,
              encodeSensitivityMap(prefixedSensitivityMap("input", start.inputSensitivityPaths)),
              hash(operationJson),
              start.acceptedAtMs,
              start.acceptedAtMs,
              start.acceptedAtMs,
            );
          connection
            .query(
              `UPDATE kojo_workflow_schedule_occurrences
                 SET outcome = 'started', linked_run_id = ?, first_attempted_at_ms = ?, processed_at_ms = ?,
                   delivery_attempt_count = delivery_attempt_count + 1, row_version = row_version + 1
               WHERE schedule_key = ? AND scheduled_at_ms = ? AND outcome = 'planned'`,
            )
            .run(
              start.runId,
              start.acceptedAtMs,
              start.acceptedAtMs,
              start.scheduleKey,
              start.scheduledAtMs,
            );
          const run = readRunSnapshot(connection, start.runId);
          if (run === undefined) throw new Error("Workflow Run was not stored");
          return { _tag: "accepted" as const, run, alreadyApplied: false };
        }),
      ),
    ),
  acceptChildStart: (start: WorkflowRunChildStartRecord) =>
    Effect.sync(() =>
      withWritableProjectStore(start.project, (connection) =>
        transaction(connection, () => {
          const parent = readStoredRun(connection, start.parentRunId);
          if (parent === undefined || parent.state !== "running") {
            return { _tag: "invocation-key-conflict" as const };
          }
          const existing =
            (connection
              .query(
                `SELECT run_id, start_request_sha256 FROM kojo_workflow_runs
                 WHERE parent_run_id = ? AND workflow_key = ? AND child_invocation_key = ?`,
              )
              .get(start.parentRunId, start.workflowKey, start.invocationKey) as {
              readonly run_id: string;
              readonly start_request_sha256: Uint8Array;
            } | null) ?? undefined;
          if (existing !== undefined) {
            if (!sameBytes(existing.start_request_sha256, start.requestHash)) {
              return { _tag: "invocation-key-conflict" as const };
            }
            const run = readRunSnapshot(connection, existing.run_id);
            if (run === undefined) throw new Error("Child Workflow Run has no stored snapshot");
            return { _tag: "accepted" as const, run, alreadyApplied: true };
          }

          const engineReferenceJson = JSON.stringify({
            kind: "effect-workflow",
            runId: start.runId,
            workflowKey: start.workflowKey,
            workflowRevision: start.workflowRevision,
          });
          const operationJson = JSON.stringify({
            input: start.encodedInput,
            workflowKey: start.workflowKey,
            workflowRevision: start.workflowRevision,
          });
          const childEventId = randomUUID();
          const parentEventId = randomUUID();
          const operationId = randomUUID();
          connection
            .query(
              `INSERT INTO kojo_workflow_runs(
                run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
                engine_reference_version, engine_reference_json, engine_reference_sha256,
                trigger_kind, parent_run_id, child_invocation_key, state, last_event_sequence,
                row_version, accepted_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'child', ?, ?, 'running', 1, 1, ?, ?)`,
            )
            .run(
              start.runId,
              start.requestKey,
              start.requestHash,
              start.workflowKey,
              start.workflowRevision,
              engineReferenceJson,
              hash(engineReferenceJson),
              start.parentRunId,
              start.invocationKey,
              start.acceptedAtMs,
              start.acceptedAtMs,
            );
          appendEvent(connection, {
            eventId: childEventId,
            kind: "run.accepted",
            payload: start.startSnapshot,
            recordedAtMs: start.acceptedAtMs,
            runId: start.runId,
            sequence: 1,
            sensitivityMap: prefixedSensitivityMap("input", start.inputSensitivityPaths),
          });
          connection
            .query(
              `INSERT INTO kojo_engine_operations(
                operation_id, run_id, kind, operation_key, request_encoding_version,
                request_schema_identity, request_json, request_sensitivity_map_version,
                request_sensitivity_map_json, request_sha256, state, attempt_count,
                next_attempt_at_ms, created_at_ms, updated_at_ms
              ) VALUES (?, ?, 'submit', 'initial', 1, 'kojo.workflow-run-submit/v1', ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
            )
            .run(
              operationId,
              start.runId,
              operationJson,
              SENSITIVITY_MAP_VERSION,
              encodeSensitivityMap(prefixedSensitivityMap("input", start.inputSensitivityPaths)),
              hash(operationJson),
              start.acceptedAtMs,
              start.acceptedAtMs,
              start.acceptedAtMs,
            );
          const parentSequence = nextEventSequence(connection, start.parentRunId);
          appendEvent(connection, {
            eventId: parentEventId,
            kind: "child.requested",
            childRunId: start.runId,
            payload: {
              invocationKey: start.invocationKey,
              runId: start.runId,
              workflowKey: start.workflowKey,
            },
            recordedAtMs: start.acceptedAtMs,
            runId: start.parentRunId,
            sequence: parentSequence,
            sensitivityMap: sensitivityMap([]),
          });
          advanceRunTrace(connection, start.parentRunId, parentSequence, start.acceptedAtMs);
          const run = readRunSnapshot(connection, start.runId);
          if (run === undefined) throw new Error("Child Workflow Run was not stored");
          return { _tag: "accepted" as const, run, alreadyApplied: false };
        }),
      ),
    ),
  list: (project, input) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        const clauses: Array<string> = [];
        const parameters: Array<string | number> = [];
        if (input.workflowKeys.length > 0) {
          clauses.push(`workflow_key IN (${input.workflowKeys.map(() => "?").join(", ")})`);
          parameters.push(...input.workflowKeys);
        }
        if (input.states.length > 0) {
          clauses.push(`state IN (${input.states.map(() => "?").join(", ")})`);
          parameters.push(...input.states);
        }
        if (input.parentRunId !== undefined) {
          clauses.push(input.parentRunId === null ? "parent_run_id IS NULL" : "parent_run_id = ?");
          if (input.parentRunId !== null) parameters.push(input.parentRunId);
        }
        parameters.push(input.limit);
        const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
        const rows = connection
          .query(
            `SELECT run_id, start_request_key, workflow_key, workflow_revision, state,
              accepted_at_ms, engine_confirmed_at_ms, updated_at_ms, finalized_at_ms, outcome_summary_json,
              outcome_event_id, parent_run_id, child_invocation_key, suspension_kind, suspension_details_json
             FROM kojo_workflow_runs ${where}
             ORDER BY accepted_at_ms DESC, run_id DESC LIMIT ?`,
          )
          .all(...parameters) as ReadonlyArray<StoredRun>;
        return rows.map((row) => toRunListItem(connection, row));
      }),
    ),
  revision: (project) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        // Read every Run's durable row version. This is an authoritative
        // project-level change fingerprint, not a capped newest-page sample;
        // a mutation to Run 501 remains visible to subscribers.
        const row = connection
          .query(
            `SELECT COUNT(*) AS count,
                    COALESCE(group_concat(revision, '|'), '') AS revisions
               FROM (
                 SELECT run_id || ':' || row_version || ':' || updated_at_ms AS revision
                   FROM kojo_workflow_runs
                  ORDER BY run_id ASC
               )`,
          )
          .get() as { readonly count: number; readonly revisions: string };
        return `${row.count}:${row.revisions}`;
      }),
    ),
  show: (project, runId) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => readRunSnapshot(connection, runId)),
    ),
  readTrace: (project, runId, input) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        readStoredExecutionTrace(connection, runId, input),
      ),
    ),
  exportTrace: (project, runId) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        exportStoredExecutionTrace(connection, runId),
      ),
    ),
  findArtifact: (project, runId, artifactId) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        const artifact =
          (connection
            .query(
              `SELECT artifact_id, storage_key, display_name, media_type, byte_size, sha256,
                      condition, created_at_ms, unavailable_at_ms, unavailable_reason_code
               FROM kojo_execution_artifacts
               WHERE run_id = ? AND artifact_id = ?`,
            )
            .get(runId, artifactId) as Parameters<typeof toStoredExecutionArtifact>[0] | null) ??
          undefined;
        return artifact === undefined ? undefined : toStoredExecutionArtifact(artifact);
      }),
    ),
  recordArtifactUnavailable: (project, runId, artifactId, reasonCode, recordedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const artifact =
            (connection
              .query(
                `SELECT condition FROM kojo_execution_artifacts
                 WHERE run_id = ? AND artifact_id = ?`,
              )
              .get(runId, artifactId) as {
              readonly condition: "available" | "missing" | "expired";
            } | null) ?? undefined;
          if (artifact?.condition !== "available") return;
          const condition = reasonCode === "artifact.expired" ? "expired" : "missing";
          const sequence = nextEventSequence(connection, runId);
          const eventId = randomUUID();
          appendEvent(connection, {
            eventId,
            kind: "artifact.unavailable",
            payload: { artifactId, condition, reasonCode },
            recordedAtMs,
            runId,
            sequence,
            sensitivityMap: sensitivityMap([]),
          });
          connection
            .query(
              `UPDATE kojo_execution_artifacts
               SET condition = ?, unavailable_at_ms = ?, unavailable_reason_code = ?
               WHERE run_id = ? AND artifact_id = ?`,
            )
            .run(condition, recordedAtMs, reasonCode, runId, artifactId);
          connection
            .query(
              `INSERT INTO kojo_execution_event_artifacts(run_id, event_id, artifact_id, role)
               VALUES (?, ?, ?, 'unavailable')`,
            )
            .run(runId, eventId, artifactId);
          advanceRunTrace(connection, runId, sequence, recordedAtMs);
        }),
      ),
    ),
  pendingSubmissions: (project, runId) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        const rows = connection
          .query(
            `SELECT operation.run_id, run.workflow_key, run.workflow_revision, operation.request_json,
                    operation.attempt_count
             FROM kojo_engine_operations operation
             JOIN kojo_workflow_runs run ON run.run_id = operation.run_id
             WHERE operation.kind = 'submit' AND operation.state = 'pending'
               AND run.state NOT IN ('stopping', 'stopped')
             ${runId === undefined ? "" : "AND operation.run_id = ?"}
             ORDER BY operation.created_at_ms ASC`,
          )
          .all(...(runId === undefined ? [] : [runId])) as ReadonlyArray<{
          readonly request_json: string;
          readonly run_id: string;
          readonly attempt_count: number;
          readonly workflow_key: string;
          readonly workflow_revision: string;
        }>;
        return rows.map((row) => {
          const request = JSON.parse(row.request_json) as { readonly input: unknown };
          return {
            project,
            runId: row.run_id,
            workflowKey: row.workflow_key,
            workflowRevision: row.workflow_revision,
            input: request.input,
            engineGeneration: row.attempt_count + 1,
          };
        });
      }),
    ),
  activeRuns: (project) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        const rows = connection
          .query(
            `SELECT run_id, parent_run_id, workflow_key, workflow_revision, state, suspension_kind
             FROM kojo_workflow_runs
             WHERE state IN ('running', 'suspended', 'stopping')
             ORDER BY accepted_at_ms ASC, run_id ASC`,
          )
          .all() as ReadonlyArray<{
          readonly parent_run_id: string | null;
          readonly run_id: string;
          readonly state: "running" | "suspended" | "stopping";
          readonly suspension_kind: "clock" | "manual" | "deferred" | null;
          readonly workflow_key: string;
          readonly workflow_revision: string;
        }>;
        return rows.map((row) => ({
          project,
          parentRunId: row.parent_run_id,
          runId: row.run_id,
          workflowKey: row.workflow_key,
          workflowRevision: row.workflow_revision,
          state: row.state,
          suspensionKind: row.suspension_kind,
        }));
      }),
    ),
  confirmSubmission: (project, runId, confirmedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const operation =
            (connection
              .query(
                "SELECT operation_id FROM kojo_engine_operations WHERE run_id = ? AND kind = 'submit' AND state = 'pending'",
              )
              .get(runId) as { readonly operation_id: string } | null) ?? undefined;
          if (operation === undefined) return;
          const run = readStoredRun(connection, runId);
          if (run === undefined)
            throw new Error("Workflow Run disappeared before submission confirmation");
          if (["stopping", "stopped"].includes(run.state)) return;
          const eventId = randomUUID();
          const sequence = connection
            .query("SELECT last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
            .get(runId) as { readonly last_event_sequence: number };
          appendEvent(connection, {
            engineOperationId: operation.operation_id,
            eventId,
            kind: "run.engine-confirmed",
            payload: { runId },
            recordedAtMs: confirmedAtMs,
            runId,
            sequence: sequence.last_event_sequence + 1,
            sensitivityMap: sensitivityMap([]),
          });
          connection
            .query(
              `UPDATE kojo_engine_operations
               SET state = 'confirmed', attempt_count = attempt_count + 1, last_attempted_at_ms = ?,
                 confirmed_at_ms = ?, confirmation_event_id = ?, next_attempt_at_ms = NULL, updated_at_ms = ?
               WHERE operation_id = ?`,
            )
            .run(confirmedAtMs, confirmedAtMs, eventId, confirmedAtMs, operation.operation_id);
          connection
            .query(
              `UPDATE kojo_workflow_runs
               SET engine_confirmed_at_ms = ?, last_event_sequence = ?, row_version = row_version + 1, updated_at_ms = ?
               WHERE run_id = ?`,
            )
            .run(confirmedAtMs, sequence.last_event_sequence + 1, confirmedAtMs, runId);
          appendParentChildEvidence(connection, run, "child.linked", confirmedAtMs);
        }),
      ),
    ),
  recordSuspension: (project, runId, suspension, suspendedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const run = readStoredRun(connection, runId);
          if (run === undefined || !["running", "suspended"].includes(run.state)) return;
          const details = JSON.stringify(suspension);
          if (
            run.state === "suspended" &&
            run.suspension_kind === suspension.kind &&
            run.suspension_details_json === details
          ) {
            return;
          }
          const sequence = connection
            .query("SELECT last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
            .get(runId) as { readonly last_event_sequence: number };
          const eventId = randomUUID();
          appendEvent(connection, {
            eventId,
            kind: "run.suspended",
            payload: suspension,
            recordedAtMs: suspendedAtMs,
            runId,
            sequence: sequence.last_event_sequence + 1,
            sensitivityMap: sensitivityMap([]),
          });
          connection
            .query(
              `UPDATE kojo_workflow_runs
               SET state = 'suspended', suspension_kind = ?, suspension_reason_code = ?,
                 suspension_details_json = ?, suspension_sensitivity_map_json = ?,
                 last_event_sequence = ?, row_version = row_version + 1, updated_at_ms = ?
               WHERE run_id = ?`,
            )
            .run(
              suspension.kind,
              `${suspension.kind}-wait`,
              details,
              encodeSensitivityMap(sensitivityMap([])),
              sequence.last_event_sequence + 1,
              suspendedAtMs,
              runId,
            );
        }),
      ),
    ),
  acceptStop: (project, options) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const activeTree = (rootRunId: string) =>
            connection
              .query(
                `WITH RECURSIVE run_tree AS (
                   SELECT run_id, parent_run_id, workflow_key, workflow_revision, state, suspension_kind
                   FROM kojo_workflow_runs WHERE run_id = ?
                   UNION ALL
                   SELECT child.run_id, child.parent_run_id, child.workflow_key, child.workflow_revision,
                          child.state, child.suspension_kind
                   FROM kojo_workflow_runs child
                   JOIN run_tree parent ON child.parent_run_id = parent.run_id
                 )
                 SELECT run_id, parent_run_id, workflow_key, workflow_revision, state, suspension_kind
                 FROM run_tree
                 WHERE state IN ('running', 'suspended', 'stopping')
                 ORDER BY run_id ASC`,
              )
              .all(rootRunId) as ReadonlyArray<{
              readonly parent_run_id: string | null;
              readonly run_id: string;
              readonly state: "running" | "suspended" | "stopping";
              readonly suspension_kind: "clock" | "manual" | "deferred" | null;
              readonly workflow_key: string;
              readonly workflow_revision: string;
            }>;
          const existing =
            (connection
              .query(
                `SELECT operation_kind, request_sha256, target_run_id
                 FROM kojo_control_requests WHERE request_key = ?`,
              )
              .get(options.requestKey) as {
              readonly operation_kind: string;
              readonly request_sha256: Uint8Array;
              readonly target_run_id: string | null;
            } | null) ?? undefined;
          if (existing !== undefined) {
            if (
              existing.operation_kind !== "run.stop" ||
              !sameBytes(existing.request_sha256, options.requestHash) ||
              existing.target_run_id !== options.runId
            ) {
              return { _tag: "request-key-conflict" as const };
            }
            const run = readRunSnapshot(connection, options.runId);
            if (run === undefined) throw new Error("Workflow Run stop receipt has no Workflow Run");
            return {
              _tag: "accepted" as const,
              run,
              runs: activeTree(options.runId).map((item) => ({
                project,
                parentRunId: item.parent_run_id,
                runId: item.run_id,
                workflowKey: item.workflow_key,
                workflowRevision: item.workflow_revision,
                state: "stopping" as const,
                suspensionKind: item.suspension_kind,
              })),
              alreadyApplied: true,
            };
          }
          const root = readStoredRun(connection, options.runId);
          if (root === undefined) return { _tag: "not-found" as const };
          if (!["running", "suspended"].includes(root.state)) {
            const run = readRunSnapshot(connection, options.runId);
            if (run === undefined) throw new Error("Workflow Run stop target disappeared");
            return { _tag: "not-stoppable" as const, run };
          }
          const tree = activeTree(options.runId);
          for (const item of tree) {
            if (item.state === "stopping") continue;
            const sequence = connection
              .query("SELECT last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
              .get(item.run_id) as { readonly last_event_sequence: number };
            appendEvent(connection, {
              eventId: randomUUID(),
              kind: "run.stop-requested",
              payload: { requestKey: options.requestKey, rootRunId: options.runId },
              recordedAtMs: options.requestedAtMs,
              runId: item.run_id,
              sequence: sequence.last_event_sequence + 1,
              sensitivityMap: sensitivityMap([]),
            });
            connection
              .query(
                `UPDATE kojo_workflow_runs
                 SET state = 'stopping', stop_request_key = COALESCE(stop_request_key, ?),
                   stop_requested_at_ms = COALESCE(stop_requested_at_ms, ?),
                   stop_reason_code = COALESCE(stop_reason_code, 'requested'),
                   suspension_kind = NULL, suspension_reason_code = NULL,
                   suspension_details_json = NULL, suspension_sensitivity_map_json = NULL,
                   last_event_sequence = ?, row_version = row_version + 1, updated_at_ms = ?
                 WHERE run_id = ?`,
              )
              .run(
                options.requestKey,
                options.requestedAtMs,
                sequence.last_event_sequence + 1,
                options.requestedAtMs,
                item.run_id,
              );
          }
          const resultJson = JSON.stringify({ runId: options.runId });
          connection
            .query(
              `INSERT INTO kojo_control_requests(
                request_key, operation_kind, request_sha256, target_kind, target_run_id, state,
                result_encoding_version, result_schema_identity, result_json,
                result_sensitivity_map_version, result_sensitivity_map_json, result_sha256,
                created_at_ms, completed_at_ms
              ) VALUES (?, 'run.stop', ?, 'run', ?, 'completed', 1,
                'kojo.workflow-run-control/v1', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              options.requestKey,
              options.requestHash,
              options.runId,
              resultJson,
              SENSITIVITY_MAP_VERSION,
              encodeSensitivityMap(sensitivityMap([])),
              hash(resultJson),
              options.requestedAtMs,
              options.requestedAtMs,
            );
          const run = readRunSnapshot(connection, options.runId);
          if (run === undefined) throw new Error("Workflow Run stop target was not stored");
          return {
            _tag: "accepted" as const,
            run,
            runs: tree.map((item) => ({
              project,
              parentRunId: item.parent_run_id,
              runId: item.run_id,
              workflowKey: item.workflow_key,
              workflowRevision: item.workflow_revision,
              state: "stopping" as const,
              suspensionKind: item.suspension_kind,
            })),
            alreadyApplied: false,
          };
        }),
      ),
    ),
  recordStopped: (project, runId, stoppedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const run = readStoredRun(connection, runId);
          if (run === undefined || run.state !== "stopping") return;
          const child = connection
            .query(
              `SELECT run_id FROM kojo_workflow_runs
               WHERE parent_run_id = ? AND state IN ('running', 'suspended', 'stopping') LIMIT 1`,
            )
            .get(runId) as { readonly run_id: string } | null;
          if (child !== null) return;
          const sequence = connection
            .query(
              "SELECT last_event_sequence, stop_request_key FROM kojo_workflow_runs WHERE run_id = ?",
            )
            .get(runId) as {
            readonly last_event_sequence: number;
            readonly stop_request_key: string | null;
          };
          const eventId = randomUUID();
          const payload = { kind: "stopped" as const, requestKey: sequence.stop_request_key };
          appendEvent(connection, {
            eventId,
            kind: "run.stopped",
            payload,
            recordedAtMs: stoppedAtMs,
            runId,
            sequence: sequence.last_event_sequence + 1,
            sensitivityMap: sensitivityMap([]),
          });
          connection
            .query(
              `UPDATE kojo_workflow_runs
               SET state = 'stopped', outcome_event_id = ?, outcome_code = 'stopped',
                 outcome_summary_json = ?, last_event_sequence = ?, row_version = row_version + 1,
                 updated_at_ms = ?, finalized_at_ms = ?
               WHERE run_id = ?`,
            )
            .run(
              eventId,
              JSON.stringify({ kind: "stopped" }),
              sequence.last_event_sequence + 1,
              stoppedAtMs,
              stoppedAtMs,
              runId,
            );
          appendParentChildEvidence(connection, run, "child.finished", stoppedAtMs, "stopped");
        }),
      ),
    ),
  recordStopAttention: (project, runId, _message, recordedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const run = readStoredRun(connection, runId);
          if (run === undefined || run.state !== "stopping") return;
          // ADR 0011 deliberately keeps routine stop diagnostics out of the
          // immutable user-visible trace. The durable Run state remains the
          // authority and Host diagnostics retain the operational detail.
          connection
            .query(
              `UPDATE kojo_workflow_runs
               SET row_version = row_version + 1, updated_at_ms = ?
               WHERE run_id = ?`,
            )
            .run(recordedAtMs, runId);
        }),
      ),
    ),
  reserveControl: (project, options) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const existing =
            (connection
              .query(
                `SELECT operation_kind, request_sha256, target_run_id, state
                 FROM kojo_control_requests WHERE request_key = ?`,
              )
              .get(options.requestKey) as {
              readonly operation_kind: string;
              readonly request_sha256: Uint8Array;
              readonly state: string;
              readonly target_run_id: string | null;
            } | null) ?? undefined;
          if (existing !== undefined) {
            if (
              existing.operation_kind !== options.kind ||
              !sameBytes(existing.request_sha256, options.requestHash) ||
              existing.target_run_id !== options.runId
            ) {
              return { _tag: "request-key-conflict" as const };
            }
            if (existing.state !== "completed") return { _tag: "accepted" as const };
            const run = readRunSnapshot(connection, options.runId);
            if (run === undefined)
              throw new Error("Workflow Run control receipt has no Workflow Run");
            return { _tag: "already-applied" as const, run };
          }
          connection
            .query(
              `INSERT INTO kojo_control_requests(
                request_key, operation_kind, request_sha256, target_kind, target_run_id, state,
                created_at_ms
              ) VALUES (?, ?, ?, 'run', ?, 'pending', ?)`,
            )
            .run(
              options.requestKey,
              options.kind,
              options.requestHash,
              options.runId,
              options.requestedAtMs,
            );
          return { _tag: "accepted" as const };
        }),
      ),
    ),
  completeControl: (project, options) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const run = readStoredRun(connection, options.runId);
          if (
            run === undefined ||
            run.state !== "suspended" ||
            run.suspension_kind !== options.expectedSuspension
          ) {
            return undefined;
          }
          const request =
            (connection
              .query(
                `SELECT state FROM kojo_control_requests
                 WHERE request_key = ? AND operation_kind = ? AND target_run_id = ?`,
              )
              .get(options.requestKey, options.kind, options.runId) as {
              readonly state: string;
            } | null) ?? undefined;
          if (request?.state !== "pending") return undefined;
          const suspension =
            run.suspension_details_json === null
              ? undefined
              : (JSON.parse(run.suspension_details_json) as WorkflowRunSuspension);
          const sequence = connection
            .query("SELECT last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
            .get(options.runId) as { readonly last_event_sequence: number };
          const eventId = randomUUID();
          const eventKind = options.kind === "run.resume" ? "run.resumed" : "deferred.completed";
          appendEvent(connection, {
            eventId,
            kind: eventKind,
            payload: {
              ...(suspension === undefined ? {} : suspension),
              requestKey: options.requestKey,
            },
            recordedAtMs: options.resumedAtMs,
            runId: options.runId,
            sequence: sequence.last_event_sequence + 1,
            sensitivityMap: sensitivityMap([]),
          });
          connection
            .query(
              `UPDATE kojo_workflow_runs
               SET state = 'running', suspension_kind = NULL, suspension_reason_code = NULL,
                 suspension_details_json = NULL, suspension_sensitivity_map_json = NULL,
                 last_event_sequence = ?, row_version = row_version + 1, updated_at_ms = ?
               WHERE run_id = ?`,
            )
            .run(sequence.last_event_sequence + 1, options.resumedAtMs, options.runId);
          const resultJson = JSON.stringify({ runId: options.runId });
          connection
            .query(
              `UPDATE kojo_control_requests
               SET state = 'completed', result_encoding_version = 1,
                 result_schema_identity = 'kojo.workflow-run-control/v1', result_json = ?,
                 result_sensitivity_map_version = ?, result_sensitivity_map_json = ?,
                 result_sha256 = ?, completed_at_ms = ?
               WHERE request_key = ?`,
            )
            .run(
              resultJson,
              SENSITIVITY_MAP_VERSION,
              encodeSensitivityMap(sensitivityMap([])),
              hash(resultJson),
              options.resumedAtMs,
              options.requestKey,
            );
          return readRunSnapshot(connection, options.runId);
        }),
      ),
    ),
  prepareActivity: (project, runId, operation, preparedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const run = readStoredRun(connection, runId);
          if (run === undefined || run.state !== "running") {
            const state =
              run?.state === "suspended" ||
              run?.state === "stopping" ||
              run?.state === "stopped" ||
              run?.state === "failed" ||
              run?.state === "completed"
                ? run.state
                : "missing";
            return {
              _tag: "run-not-running" as const,
              state,
            };
          }
          const existing =
            (connection
              .query(
                `SELECT activity_name, definition_fingerprint, execution_generation, confirmed_attempt_id,
                result_json
                 FROM kojo_workflow_activity_operations
                 WHERE run_id = ? AND durable_operation_key = ?`,
              )
              .get(runId, operation.durableOperationKey) as {
              readonly activity_name: string;
              readonly confirmed_attempt_id: string | null;
              readonly definition_fingerprint: string;
              readonly execution_generation: number;
              readonly result_json: string | null;
            } | null) ?? undefined;
          if (existing === undefined) {
            connection
              .query(
                `INSERT INTO kojo_workflow_activity_operations(
                  run_id, durable_operation_key, activity_name, definition_fingerprint,
                  execution_generation, prepared_at_ms
                ) VALUES (?, ?, ?, ?, 1, ?)`,
              )
              .run(
                runId,
                operation.durableOperationKey,
                operation.activityName,
                operation.definitionFingerprint,
                preparedAtMs,
              );
            return { _tag: "ready" as const, executionGeneration: 1 };
          }
          const latestAttempt = connection
            .query(
              `SELECT execution_generation, state FROM kojo_workflow_activity_attempts
               WHERE run_id = ? AND durable_operation_key = ?
               ORDER BY invocation_number DESC
               LIMIT 1`,
            )
            .get(runId, operation.durableOperationKey) as {
            readonly execution_generation: number;
            readonly state: "started" | "result-observed" | "engine-confirmed";
          } | null;
          const decision = decideWorkflowActivityReplay(
            operation,
            {
              activityName: existing.activity_name,
              confirmedAttemptId: existing.confirmed_attempt_id,
              definitionFingerprint: existing.definition_fingerprint,
              durableOperationKey: operation.durableOperationKey,
              executionGeneration: existing.execution_generation,
              resultJson: existing.result_json,
            },
            latestAttempt === null
              ? undefined
              : {
                  executionGeneration: latestAttempt.execution_generation,
                  state: latestAttempt.state,
                },
          );
          if (decision._tag === "completed") {
            return {
              ...decision,
              result: JSON.parse(decision.resultJson),
            };
          }
          return decision;
        }),
      ),
    ),
  startActivityAttempt: (project, runId, operation, options, startedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const run = readStoredRun(connection, runId);
          if (run === undefined || run.state !== "running") {
            throw new Error("Workflow Run does not accept new Activity work while stopping");
          }
          const registered =
            (connection
              .query(
                `SELECT activity_name, definition_fingerprint, execution_generation
                 FROM kojo_workflow_activity_operations
                 WHERE run_id = ? AND durable_operation_key = ?`,
              )
              .get(runId, operation.durableOperationKey) as {
              readonly activity_name: string;
              readonly definition_fingerprint: string;
              readonly execution_generation: number;
            } | null) ?? undefined;
          if (
            registered === undefined ||
            registered.activity_name !== operation.activityName ||
            registered.definition_fingerprint !== operation.definitionFingerprint ||
            registered.execution_generation !== options.executionGeneration
          ) {
            throw new Error("Workflow Activity was not prepared for this Durable Operation Key");
          }
          const alreadyStarted = connection
            .query(
              `SELECT attempt_id FROM kojo_workflow_activity_attempts
               WHERE run_id = ? AND durable_operation_key = ? AND execution_generation = ?
                 AND effect_retry_number = ?
               LIMIT 1`,
            )
            .get(
              runId,
              operation.durableOperationKey,
              options.executionGeneration,
              options.effectRetryNumber,
            ) as { readonly attempt_id: string } | null;
          if (alreadyStarted !== null) return undefined;
          const invocation = connection
            .query(
              `SELECT COALESCE(MAX(invocation_number), 0) + 1 AS invocation_number
               FROM kojo_workflow_activity_attempts
               WHERE run_id = ? AND durable_operation_key = ?`,
            )
            .get(runId, operation.durableOperationKey) as { readonly invocation_number: number };
          const attempt: WorkflowActivityAttemptRecord = {
            ...operation,
            attemptId: randomUUID(),
            executionGeneration: options.executionGeneration,
            activityIdempotencyKey: options.activityIdempotencyKey,
            effectRetryNumber: options.effectRetryNumber,
            invocationNumber: invocation.invocation_number,
          };
          connection
            .query(
              `INSERT INTO kojo_workflow_activity_attempts(
                attempt_id, run_id, durable_operation_key, activity_name, execution_generation,
                effect_retry_number, invocation_number, activity_idempotency_key, state, started_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
            )
            .run(
              attempt.attemptId,
              runId,
              attempt.durableOperationKey,
              attempt.activityName,
              attempt.executionGeneration,
              attempt.effectRetryNumber,
              attempt.invocationNumber,
              attempt.activityIdempotencyKey,
              startedAtMs,
            );
          const sequence = nextEventSequence(connection, runId);
          appendEvent(connection, {
            activityAttemptId: attempt.attemptId,
            eventId: randomUUID(),
            kind: "activity.attempt-started",
            payload: {
              activityIdempotencyKey: attempt.activityIdempotencyKey,
              activityName: attempt.activityName,
              durableOperationKey: attempt.durableOperationKey,
              effectRetryNumber: attempt.effectRetryNumber,
              invocationNumber: attempt.invocationNumber,
            },
            recordedAtMs: startedAtMs,
            runId,
            sequence,
            sensitivityMap: sensitivityMap([]),
          });
          advanceRunTrace(connection, runId, sequence, startedAtMs);
          return attempt;
        }),
      ),
    ),
  observeActivityAttempt: (project, runId, attemptId, outcomeCode, observedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const attempt =
            (connection
              .query(
                `SELECT durable_operation_key, activity_name, state
                 FROM kojo_workflow_activity_attempts WHERE run_id = ? AND attempt_id = ?`,
              )
              .get(runId, attemptId) as {
              readonly activity_name: string;
              readonly durable_operation_key: string;
              readonly state: "started" | "result-observed" | "engine-confirmed";
            } | null) ?? undefined;
          if (attempt === undefined || attempt.state !== "started") return;
          const sequence = nextEventSequence(connection, runId);
          appendEvent(connection, {
            activityAttemptId: attemptId,
            eventId: randomUUID(),
            kind: "activity.result-observed",
            payload: {
              activityName: attempt.activity_name,
              durableOperationKey: attempt.durable_operation_key,
              outcomeCode,
            },
            recordedAtMs: observedAtMs,
            runId,
            sequence,
            sensitivityMap: sensitivityMap([]),
          });
          connection
            .query(
              `UPDATE kojo_workflow_activity_attempts
               SET state = 'result-observed', outcome_code = ?, result_observed_at_ms = ?
               WHERE attempt_id = ?`,
            )
            .run(outcomeCode, observedAtMs, attemptId);
          advanceRunTrace(connection, runId, sequence, observedAtMs);
        }),
      ),
    ),
  confirmActivityAttempt: (project, runId, attemptId, result, confirmedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const attempt =
            (connection
              .query(
                `SELECT durable_operation_key, activity_name, execution_generation, state
                 FROM kojo_workflow_activity_attempts WHERE run_id = ? AND attempt_id = ?`,
              )
              .get(runId, attemptId) as {
              readonly activity_name: string;
              readonly durable_operation_key: string;
              readonly execution_generation: number;
              readonly state: "started" | "result-observed" | "engine-confirmed";
            } | null) ?? undefined;
          if (attempt === undefined || attempt.state === "engine-confirmed") return;
          if (attempt.state !== "result-observed") {
            throw new Error(
              "Workflow Activity result was not observed before durable confirmation",
            );
          }
          const operation =
            (connection
              .query(
                `SELECT confirmed_attempt_id, execution_generation
                 FROM kojo_workflow_activity_operations
                 WHERE run_id = ? AND durable_operation_key = ?`,
              )
              .get(runId, attempt.durable_operation_key) as {
              readonly confirmed_attempt_id: string | null;
              readonly execution_generation: number;
            } | null) ?? undefined;
          if (operation === undefined) throw new Error("Workflow Activity operation disappeared");
          if (operation.execution_generation !== attempt.execution_generation) {
            return;
          }
          if (
            operation.confirmed_attempt_id !== null &&
            operation.confirmed_attempt_id !== attemptId
          ) {
            throw new Error("Workflow Activity Durable Operation Key has conflicting completion");
          }
          const sequence = nextEventSequence(connection, runId);
          appendEvent(connection, {
            activityAttemptId: attemptId,
            eventId: randomUUID(),
            kind: "activity.result-confirmed",
            payload: {
              activityName: attempt.activity_name,
              durableOperationKey: attempt.durable_operation_key,
            },
            recordedAtMs: confirmedAtMs,
            runId,
            sequence,
            sensitivityMap: sensitivityMap([]),
          });
          connection
            .query(
              `UPDATE kojo_workflow_activity_attempts
               SET state = 'engine-confirmed', engine_confirmed_at_ms = ?
               WHERE attempt_id = ?`,
            )
            .run(confirmedAtMs, attemptId);
          connection
            .query(
              `UPDATE kojo_workflow_activity_operations
               SET confirmed_attempt_id = ?, result_json = ?
               WHERE run_id = ? AND durable_operation_key = ?`,
            )
            .run(attemptId, JSON.stringify(result), runId, attempt.durable_operation_key);
          advanceRunTrace(connection, runId, sequence, confirmedAtMs);
        }),
      ),
    ),
  recordActivityReplayReuse: (project, runId, operation, confirmedAttemptId, recordedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const stored =
            (connection
              .query(
                `SELECT activity_name, definition_fingerprint, confirmed_attempt_id
                 FROM kojo_workflow_activity_operations
                 WHERE run_id = ? AND durable_operation_key = ?`,
              )
              .get(runId, operation.durableOperationKey) as {
              readonly activity_name: string;
              readonly confirmed_attempt_id: string | null;
              readonly definition_fingerprint: string;
            } | null) ?? undefined;
          if (
            stored?.activity_name !== operation.activityName ||
            stored.definition_fingerprint !== operation.definitionFingerprint ||
            stored.confirmed_attempt_id !== confirmedAttemptId
          ) {
            throw new Error(
              "Workflow Activity replay evidence does not match its Durable Operation Key",
            );
          }
          const sequence = nextEventSequence(connection, runId);
          appendEvent(connection, {
            activityAttemptId: confirmedAttemptId,
            eventId: randomUUID(),
            kind: "activity.result-reused",
            payload: {
              activityName: operation.activityName,
              durableOperationKey: operation.durableOperationKey,
            },
            recordedAtMs,
            runId,
            sequence,
            sensitivityMap: sensitivityMap([]),
          });
          advanceRunTrace(connection, runId, sequence, recordedAtMs);
        }),
      ),
    ),
  recordSandboxTrace: (project, runId, trace) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const sequence = nextEventSequence(connection, runId);
          const eventId = randomUUID();
          appendEvent(connection, {
            boundaryId: trace.operationKey,
            eventId,
            kind: settledBoundaryKind(trace.kind),
            payload: {
              artifactIds: trace.artifactIds,
              durationMs: trace.durationMs,
              evidence: { kind: trace.kind, source: "sandbox" },
              exitCode: trace.exitCode,
              operationKey: trace.operationKey,
              providerKind: trace.providerKind,
              sandboxIdentity: trace.sandboxIdentity,
            },
            recordedAtMs: trace.recordedAtMs,
            runId,
            sequence,
            sensitivityMap: sensitivityMap([]),
          });
          for (const artifact of trace.artifacts) {
            connection
              .query(
                `INSERT INTO kojo_execution_artifacts(
                  artifact_id, run_id, storage_key, display_name, media_type, byte_size, sha256,
                  condition, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
              )
              .run(
                artifact.artifactId,
                runId,
                artifact.storageKey,
                artifact.displayName,
                artifact.mediaType,
                artifact.byteSize,
                artifact.sha256,
                trace.recordedAtMs,
              );
            connection
              .query(
                `INSERT INTO kojo_execution_event_artifacts(run_id, event_id, artifact_id, role)
                 VALUES (?, ?, ?, 'evidence')`,
              )
              .run(runId, eventId, artifact.artifactId);
          }
          advanceRunTrace(connection, runId, sequence, trace.recordedAtMs);
        }),
      ),
    ),
  recordAgentTrace: (project, runId, trace) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const sequence = nextEventSequence(connection, runId);
          const eventId = randomUUID();
          appendEvent(connection, {
            boundaryId: trace.operationKey,
            eventId,
            kind: settledBoundaryKind(trace.kind),
            payload: {
              artifactIds: trace.artifactIds,
              durationMs: trace.durationMs,
              evidence: { kind: trace.kind, source: "agent" },
              operationKey: trace.operationKey,
              providerKind: trace.providerKind,
              sandboxIdentity: trace.sandboxIdentity,
            },
            recordedAtMs: trace.recordedAtMs,
            runId,
            sequence,
            sensitivityMap: sensitivityMap([]),
          });
          for (const artifact of trace.artifacts) {
            connection
              .query(
                `INSERT INTO kojo_execution_artifacts(
                  artifact_id, run_id, storage_key, display_name, media_type, byte_size, sha256,
                  condition, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
              )
              .run(
                artifact.artifactId,
                runId,
                artifact.storageKey,
                artifact.displayName,
                artifact.mediaType,
                artifact.byteSize,
                artifact.sha256,
                trace.recordedAtMs,
              );
            connection
              .query(
                `INSERT INTO kojo_execution_event_artifacts(run_id, event_id, artifact_id, role)
                 VALUES (?, ?, ?, 'evidence')`,
              )
              .run(runId, eventId, artifact.artifactId);
          }
          advanceRunTrace(connection, runId, sequence, trace.recordedAtMs);
        }),
      ),
    ),
  recoverActivitySubmission: (project, runId, hostStartedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const recoveredActivities = connection
            .query(
              `UPDATE kojo_workflow_activity_operations
               SET execution_generation = execution_generation + 1
               WHERE run_id = ? AND confirmed_attempt_id IS NULL
                 AND EXISTS (
                   SELECT 1 FROM kojo_workflow_activity_attempts
                   WHERE kojo_workflow_activity_attempts.run_id =
                       kojo_workflow_activity_operations.run_id
                     AND kojo_workflow_activity_attempts.durable_operation_key =
                       kojo_workflow_activity_operations.durable_operation_key
                     AND state != 'engine-confirmed' AND started_at_ms < ?
                 )`,
            )
            .run(runId, hostStartedAtMs);
          if (recoveredActivities.changes === 0) return false;
          const updated = connection
            .query(
              `UPDATE kojo_engine_operations
               SET state = 'pending', next_attempt_at_ms = ?, confirmed_at_ms = NULL,
                 confirmation_event_id = NULL, updated_at_ms = ?
               WHERE run_id = ? AND kind = 'submit' AND state = 'confirmed'
                 AND last_attempted_at_ms < ?`,
            )
            .run(hostStartedAtMs, hostStartedAtMs, runId, hostStartedAtMs);
          if (updated.changes === 0) return false;
          return true;
        }),
      ),
    ),
  engineGeneration: (project, runId) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) => {
        const operation =
          (connection
            .query(
              `SELECT state, attempt_count FROM kojo_engine_operations
               WHERE run_id = ? AND kind = 'submit'`,
            )
            .get(runId) as {
            readonly attempt_count: number;
            readonly state: "pending" | "confirmed" | "needs-attention";
          } | null) ?? undefined;
        if (operation === undefined) return undefined;
        return operation.attempt_count + (operation.state === "pending" ? 1 : 0);
      }),
    ),
  recordOutcome: (project, runId, outcome, finalizedAtMs) =>
    Effect.sync(() =>
      withWritableProjectStore(project, (connection) =>
        transaction(connection, () => {
          const run = readStoredRun(connection, runId);
          if (run === undefined) return;
          if (preservesStoppedOutcome(run.state)) {
            const sequence = connection
              .query("SELECT last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
              .get(runId) as { readonly last_event_sequence: number };
            appendEvent(connection, {
              eventId: randomUUID(),
              kind: "run.late-engine-outcome",
              payload: {
                kind: outcome.kind,
                ...(outcome.value === undefined ? {} : { value: outcome.value }),
              },
              recordedAtMs: finalizedAtMs,
              runId,
              sequence: sequence.last_event_sequence + 1,
              sensitivityMap: prefixedSensitivityMap("value", outcome.sensitivityPaths),
            });
            connection
              .query(
                `UPDATE kojo_workflow_runs
                 SET last_event_sequence = ?, row_version = row_version + 1, updated_at_ms = ?
                 WHERE run_id = ?`,
              )
              .run(sequence.last_event_sequence + 1, finalizedAtMs, runId);
            return;
          }
          if (!["running", "suspended"].includes(run.state)) return;
          const nonFinalChild = connection
            .query(
              `SELECT run_id FROM kojo_workflow_runs
               WHERE parent_run_id = ? AND state IN ('running', 'suspended', 'stopping') LIMIT 1`,
            )
            .get(runId) as { readonly run_id: string } | null;
          if (nonFinalChild !== null) return;
          const sequence = connection
            .query("SELECT last_event_sequence FROM kojo_workflow_runs WHERE run_id = ?")
            .get(runId) as { readonly last_event_sequence: number };
          const eventId = randomUUID();
          const payload = {
            kind: outcome.kind,
            ...(outcome.value === undefined ? {} : { value: outcome.value }),
          };
          appendEvent(connection, {
            eventId,
            kind: outcome.kind === "completed" ? "run.completed" : "run.failed",
            payload,
            recordedAtMs: finalizedAtMs,
            runId,
            sequence: sequence.last_event_sequence + 1,
            sensitivityMap: prefixedSensitivityMap("value", outcome.sensitivityPaths),
          });
          const outcomeJson = JSON.stringify(payload);
          connection
            .query(
              `UPDATE kojo_workflow_runs
               SET state = ?, outcome_event_id = ?, outcome_code = ?, outcome_summary_json = ?,
                 suspension_kind = NULL, suspension_reason_code = NULL,
                 suspension_details_json = NULL, suspension_sensitivity_map_json = NULL,
                 last_event_sequence = ?, row_version = row_version + 1, updated_at_ms = ?, finalized_at_ms = ?
               WHERE run_id = ?`,
            )
            .run(
              outcome.kind,
              eventId,
              outcome.kind,
              outcomeJson,
              sequence.last_event_sequence + 1,
              finalizedAtMs,
              finalizedAtMs,
              runId,
            );
          appendParentChildEvidence(connection, run, "child.finished", finalizedAtMs, outcome.kind);
        }),
      ),
    ),
}));
