import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
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

const projectSourceState = sqliteTable("project_source_state", {
  activeRevision: text("active_revision"),
  diagnostics: text("diagnostics").notNull(),
  projectId: text("project_id").primaryKey(),
  sourcePolicy: text("source_policy").notNull(),
  updatedAt: text("updated_at").notNull(),
});

const workflowRevisions = sqliteTable("workflow_revisions", {
  createdAt: text("created_at").notNull(),
  declaredVersion: text("declared_version").notNull(),
  fingerprint: text("fingerprint").primaryKey(),
  source: text("source").notNull(),
  stableName: text("stable_name").notNull(),
  workflowAbi: text("workflow_abi").notNull(),
});

const workflowRuns = sqliteTable("workflow_runs", {
  createdAt: text("created_at").notNull(),
  input: text("input").notNull(),
  outcome: text("outcome"),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  revisionFingerprint: text("revision_fingerprint")
    .notNull()
    .references(() => workflowRevisions.fingerprint),
  rootRunId: text("root_run_id").notNull(),
  runId: text("run_id").primaryKey(),
  state: text("state").notNull(),
  trigger: text("trigger").notNull(),
  updatedAt: text("updated_at").notNull(),
});

const workflowRevisionSnapshots = sqliteTable("workflow_revision_snapshots", {
  createdAt: text("created_at").notNull(),
  rootRunId: text("root_run_id")
    .primaryKey()
    .references(() => workflowRuns.runId),
  snapshot: text("snapshot").notNull(),
});

const runtimeConfigurationSnapshots = sqliteTable("runtime_configuration_snapshots", {
  createdAt: text("created_at").notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => workflowRuns.runId),
  snapshot: text("snapshot").notNull(),
  subject: text("subject").notNull(),
});

const executionAttempts = sqliteTable("execution_attempts", {
  finishedAt: text("finished_at"),
  number: integer("number").notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => workflowRuns.runId),
  startedAt: text("started_at").notNull(),
  state: text("state").notNull(),
});

const executionLeases = sqliteTable("execution_leases", {
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  generation: integer("generation").notNull(),
  holder: text("holder").notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => workflowRuns.runId),
  state: text("state").notNull(),
});

const activityClaims = sqliteTable("activity_claims", {
  attempt: integer("attempt").notNull(),
  completionIdempotencyKey: text("completion_idempotency_key").notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => workflowRuns.runId),
  startedIdempotencyKey: text("started_idempotency_key").notNull(),
  subject: text("subject").notNull(),
});

const workflowJournal = sqliteTable("workflow_journal", {
  attempt: integer("attempt").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  operation: text("operation").notNull(),
  payload: text("payload").notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => workflowRuns.runId),
  sequence: integer("sequence").notNull(),
  writtenAt: text("written_at").notNull(),
});

const evidenceEvents = sqliteTable("evidence_events", {
  attempt: integer("attempt").notNull(),
  causationId: text("causation_id"),
  details: text("details").notNull(),
  eventId: text("event_id").notNull().unique(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  parentEventId: text("parent_event_id"),
  recordedAt: text("recorded_at").notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => workflowRuns.runId),
  sequence: integer("sequence").notNull(),
  subject: text("subject").notNull(),
  type: text("type").notNull(),
});

const executionArtifacts = sqliteTable("execution_artifacts", {
  byteLength: integer("byte_length").notNull(),
  createdAt: text("created_at").notNull(),
  fingerprint: text("fingerprint").primaryKey(),
  mediaType: text("media_type").notNull(),
  path: text("path").notNull().unique(),
});

const evidenceArtifacts = sqliteTable("evidence_artifacts", {
  artifactFingerprint: text("artifact_fingerprint")
    .notNull()
    .references(() => executionArtifacts.fingerprint),
  eventId: text("event_id")
    .notNull()
    .references(() => evidenceEvents.eventId),
  name: text("name").notNull(),
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
  {
    id: 3,
    statements: [
      `CREATE TABLE project_source_state (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),
        source_policy TEXT NOT NULL CHECK (source_policy IN ('LocalWithFreshnessWarning', 'RemoteLatest')),
        active_revision TEXT,
        diagnostics TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (active_revision IS NOT NULL AND diagnostics = '[]') OR
          (active_revision IS NULL AND diagnostics <> '[]')
        )
      )`,
    ],
  },
  {
    id: 4,
    statements: [
      `CREATE TABLE workflow_revisions (
        fingerprint TEXT PRIMARY KEY NOT NULL,
        stable_name TEXT NOT NULL,
        declared_version TEXT NOT NULL,
        workflow_abi TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE workflow_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        root_run_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        revision_fingerprint TEXT NOT NULL REFERENCES workflow_revisions(fingerprint),
        state TEXT NOT NULL CHECK (state IN ('Running', 'Suspended', 'Interrupted', 'Failed', 'Completed', 'Discarded')),
        input TEXT NOT NULL,
        outcome TEXT,
        trigger TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE execution_attempts (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
        number INTEGER NOT NULL CHECK (number > 0),
        state TEXT NOT NULL CHECK (state IN ('Running', 'Suspended', 'Interrupted', 'Failed', 'Completed', 'Discarded')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (run_id, number)
      )`,
      `CREATE TABLE execution_leases (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
        generation INTEGER NOT NULL CHECK (generation > 0),
        holder TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('Active', 'Released', 'Expired', 'Superseded')),
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (run_id, generation)
      )`,
      `CREATE UNIQUE INDEX execution_leases_one_active ON execution_leases(run_id) WHERE state = 'Active'`,
      `CREATE TABLE workflow_journal (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        written_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        UNIQUE (run_id, idempotency_key)
      )`,
      `CREATE TABLE evidence_events (
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        parent_event_id TEXT,
        causation_id TEXT,
        details TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      )`,
      `CREATE TABLE execution_artifacts (
        fingerprint TEXT PRIMARY KEY NOT NULL,
        path TEXT NOT NULL UNIQUE,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE evidence_artifacts (
        event_id TEXT NOT NULL REFERENCES evidence_events(event_id),
        artifact_fingerprint TEXT NOT NULL REFERENCES execution_artifacts(fingerprint),
        name TEXT NOT NULL,
        PRIMARY KEY (event_id, artifact_fingerprint, name)
      )`,
    ],
  },
  {
    id: 5,
    irreversible: true,
    statements: [
      `CREATE TABLE workflow_revision_snapshots (
        root_run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_runs(run_id),
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    id: 6,
    statements: [
      `CREATE TABLE activity_claims (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
        started_idempotency_key TEXT NOT NULL,
        completion_idempotency_key TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        subject TEXT NOT NULL,
        PRIMARY KEY (run_id, started_idempotency_key),
        UNIQUE (run_id, completion_idempotency_key)
      )`,
    ],
  },
  {
    id: 7,
    statements: [
      `CREATE TABLE runtime_configuration_snapshots (
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
        subject TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, subject)
      )`,
    ],
  },
] as const;

const migrationChecksum = (statements: ReadonlyArray<string>) =>
  createHash("sha256").update(statements.join(";\n")).digest("hex");

export const kojoSchemaMigrations = migrations.map((migration) => ({
  checksum: migrationChecksum(migration.statements),
  id: migration.id,
}));

export const kojoSchemaVersion = migrations.length;

const encodePayload = (value: unknown) => JSON.stringify({ encodingVersion: 1, value });
const decodePayload = <A>(value: string): A => (JSON.parse(value) as { readonly value: A }).value;

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
  readonly projectSources: ProjectSourceRepository;
  readonly workflowJournal: WorkflowJournalRepository;
  readonly workflowRuns: WorkflowRunRepository;
}

export type WorkflowRunState =
  | "Running"
  | "Suspended"
  | "Interrupted"
  | "Failed"
  | "Completed"
  | "Discarded";

export interface StoredWorkflowRevision {
  readonly createdAt: string;
  readonly declaredVersion: string;
  readonly fingerprint: string;
  readonly source: string;
  readonly stableName: string;
  readonly workflowAbi: string;
}

export interface StoredWorkflowRun {
  readonly createdAt: string;
  readonly input: string;
  readonly outcome: string | null;
  readonly projectId: string;
  readonly revisionFingerprint: string;
  readonly rootRunId: string;
  readonly runId: string;
  readonly state: WorkflowRunState;
  readonly trigger: string;
  readonly updatedAt: string;
}

export interface StoredExecutionAttempt {
  readonly finishedAt: string | null;
  readonly number: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly state: WorkflowRunState;
}

export interface StoredExecutionLease {
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly generation: number;
  readonly holder: string;
  readonly runId: string;
  readonly state: "Active" | "Expired" | "Released" | "Superseded";
}

export interface StoredEvidenceEvent {
  readonly attempt: number;
  readonly causationId: string | null;
  readonly details: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly parentEventId: string | null;
  readonly recordedAt: string;
  readonly runId: string;
  readonly sequence: number;
  readonly subject: string;
  readonly type: string;
}

export interface StoredWorkflowJournalEntry {
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly payload: string;
  readonly runId: string;
  readonly sequence: number;
  readonly writtenAt: string;
}

export interface StoredWorkflowRevisionSnapshot {
  readonly createdAt: string;
  readonly rootRunId: string;
  readonly snapshot: string;
}

export interface ExecutionWriteScope {
  readonly attempt: number;
  readonly leaseGeneration: number;
  readonly leaseHolder: string;
  readonly projectId: string;
  readonly rootRunId: string;
  readonly runId: string;
}

export interface WorkflowStartRecord {
  readonly attempt: StoredExecutionAttempt;
  readonly evidence: StoredEvidenceEvent;
  readonly journal: StoredWorkflowJournalEntry;
  readonly lease: StoredExecutionLease;
  readonly revision: StoredWorkflowRevision;
  readonly revisionSnapshot: StoredWorkflowRevisionSnapshot;
  readonly run: StoredWorkflowRun;
}

export interface WorkflowTerminalRecord {
  readonly evidence: StoredEvidenceEvent;
  readonly journal: StoredWorkflowJournalEntry;
  readonly outcome: string;
  readonly runId: string;
  readonly state: "Completed" | "Failed";
}

export interface WorkflowRunRepository {
  readonly appendBoundary: (
    record: {
      readonly details: string;
      readonly idempotencyKey: string;
      readonly operation: string;
      readonly subject: string;
    } & ExecutionWriteScope,
  ) => StoredEvidenceEvent;
  readonly claimActivity: (
    record: {
      readonly completionIdempotencyKey: string;
      readonly details: string;
      readonly idempotencyKey: string;
      readonly operation: "Activity.Started";
      readonly subject: string;
    } & ExecutionWriteScope,
  ) =>
    | { readonly evidence: StoredEvidenceEvent; readonly status: "execute" }
    | { readonly evidence: StoredEvidenceEvent; readonly status: "uncertain" }
    | { readonly evidence: StoredEvidenceEvent; readonly status: "discarded" | "suspended" }
    | { readonly payload: string; readonly status: "replay" };
  readonly discard: (
    runId: string,
  ) =>
    | { readonly runId: string; readonly state: "Discarded"; readonly status: "discarded" }
    | { readonly runId: string; readonly state: "Running"; readonly status: "requested" };
  readonly finalize: (record: WorkflowTerminalRecord, scope: ExecutionWriteScope) => void;
  readonly find: (runId: string) =>
    | {
        readonly attempts: ReadonlyArray<StoredExecutionAttempt>;
        readonly evidence: ReadonlyArray<StoredEvidenceEvent>;
        readonly lease: StoredExecutionLease | undefined;
        readonly revision: StoredWorkflowRevision;
        readonly revisionSnapshot: StoredWorkflowRevisionSnapshot | undefined;
        readonly run: StoredWorkflowRun;
      }
    | undefined;
  readonly list: () => ReadonlyArray<StoredWorkflowRun>;
  readonly interruptRunning: () => ReadonlyArray<string>;
  readonly interruptScope: (
    scope: ExecutionWriteScope,
    reason: "ProjectRuntimeProcessLost",
  ) => boolean;
  readonly reconcileExpiredLeases: () => ReadonlyArray<string>;
  readonly registerArtifact: (
    record: {
      readonly byteLength: number;
      readonly fingerprint: string;
      readonly mediaType: string;
      readonly path: string;
    } & ExecutionWriteScope,
  ) => void;
  readonly requestSuspend: (
    runId: string,
    reason?: "Operator" | "SystemProcessStop",
  ) => {
    readonly runId: string;
    readonly state: WorkflowRunState;
    readonly status: "requested";
  };
  readonly readBoundary: (
    scope: ExecutionWriteScope,
    idempotencyKey: string,
  ) => StoredWorkflowJournalEntry | undefined;
  readonly renewLease: (scope: ExecutionWriteScope, expiresAt: string) => void;
  readonly resume: (record: {
    readonly attempt: StoredExecutionAttempt;
    readonly evidence: StoredEvidenceEvent;
    readonly journal: StoredWorkflowJournalEntry;
    readonly lease: StoredExecutionLease;
    readonly runId: string;
  }) => void;
  readonly start: (record: WorkflowStartRecord) => void;
  readonly verifyRuntimeConfiguration: (
    record: {
      readonly snapshot: string;
      readonly subject: string;
    } & ExecutionWriteScope,
  ) => {
    readonly evidence: StoredEvidenceEvent;
    readonly status: "compatible" | "incompatible" | "recorded";
  };
}

export interface WorkflowJournalRepository {
  readonly list: (runId: string) => ReadonlyArray<StoredWorkflowJournalEntry>;
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

export type StoredProjectSourcePolicy = "LocalWithFreshnessWarning" | "RemoteLatest";

export interface StoredProjectSourceState {
  readonly activeRevision: string | null;
  readonly diagnostics: string;
  readonly projectId: string;
  readonly sourcePolicy: StoredProjectSourcePolicy;
  readonly updatedAt: string;
}

export interface ProjectSourceRepository {
  readonly activate: (
    projectId: string,
    sourcePolicy: StoredProjectSourcePolicy,
    revision: string,
  ) => StoredProjectSourceState;
  readonly findByProjectId: (projectId: string) => StoredProjectSourceState | undefined;
  readonly reject: (
    projectId: string,
    sourcePolicy: StoredProjectSourcePolicy,
    diagnostics: string,
  ) => StoredProjectSourceState;
}

export const openSystemStore = async (home: string): Promise<SystemStore> => {
  await mkdir(home, { mode: 0o700, recursive: true });
  await chmod(home, 0o700);

  const databasePath = join(home, "state.sqlite");
  const sqlite = new Database(databasePath, { create: true, strict: true });

  try {
    const database = drizzle(sqlite);
    const integrity = database.get<[unknown]>(sql.raw("PRAGMA integrity_check"))?.[0];
    if (integrity !== "ok") {
      throw new Error("state.sqlite failed its integrity check");
    }
    const metadataTable = sqlite
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'system_metadata'",
      )
      .get() as { readonly present: number } | null;
    const recordedSchemaVersion =
      metadataTable === null
        ? undefined
        : (
            sqlite
              .query("SELECT value FROM system_metadata WHERE key = 'schema_version'")
              .get() as { readonly value: string } | null
          )?.value;
    if (recordedSchemaVersion !== undefined) {
      const parsedSchemaVersion = Number(recordedSchemaVersion);
      if (!Number.isSafeInteger(parsedSchemaVersion) || parsedSchemaVersion < 0) {
        throw new Error(
          `state.sqlite schema version ${recordedSchemaVersion} is invalid and cannot be migrated safely`,
        );
      }
      if (parsedSchemaVersion > kojoSchemaVersion) {
        throw new Error(
          `state.sqlite schema version ${parsedSchemaVersion} is newer than supported version ${kojoSchemaVersion}`,
        );
      }
    }
    const migrationTable = sqlite
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'kojo_migrations'",
      )
      .get() as { readonly present: number } | null;
    const applied =
      migrationTable === null
        ? []
        : (sqlite
            .query("SELECT id, checksum FROM kojo_migrations ORDER BY id")
            .all() as ReadonlyArray<{ readonly checksum: string; readonly id: number }>);
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

    database.run(
      sql.raw(`CREATE TABLE IF NOT EXISTS kojo_migrations (
      id INTEGER PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`),
    );

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.statements);
      const existing = applied.find((candidate) => candidate.id === migration.id);
      if (existing?.checksum !== undefined && existing.checksum !== checksum) {
        throw new Error(`state.sqlite migration ${migration.id} checksum does not match`);
      }
      if (existing !== undefined) {
        continue;
      }

      if ("irreversible" in migration && migration.irreversible && applied.length > 0) {
        const { backupKojoHome } = await import("./home-maintenance");
        const backupPath = join(
          home,
          "backups",
          `before-migration-${migration.id}-${new Date().toISOString().replaceAll(":", "-")}`,
        );
        await backupKojoHome(home, backupPath);
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

    const selectProjectSource = {
      activeRevision: projectSourceState.activeRevision,
      diagnostics: projectSourceState.diagnostics,
      projectId: projectSourceState.projectId,
      sourcePolicy: projectSourceState.sourcePolicy,
      updatedAt: projectSourceState.updatedAt,
    };
    const decodeProjectSource = (
      source: typeof projectSourceState.$inferSelect,
    ): StoredProjectSourceState => ({
      ...source,
      sourcePolicy: source.sourcePolicy as StoredProjectSourcePolicy,
    });
    const writeProjectSource = (
      projectId: string,
      sourcePolicy: StoredProjectSourcePolicy,
      activeRevision: string | null,
      diagnostics: string,
    ) =>
      database.transaction((transaction) => {
        const updatedAt = new Date().toISOString();
        transaction
          .insert(projectSourceState)
          .values({ activeRevision, diagnostics, projectId, sourcePolicy, updatedAt })
          .onConflictDoUpdate({
            set: { activeRevision, diagnostics, sourcePolicy, updatedAt },
            target: projectSourceState.projectId,
          })
          .run();
        const stored = transaction
          .select(selectProjectSource)
          .from(projectSourceState)
          .where(eq(projectSourceState.projectId, projectId))
          .get();
        if (stored === undefined)
          throw new Error(`Project source state for ${projectId} was not stored`);
        return decodeProjectSource(stored);
      });
    const projectSourceRepository: ProjectSourceRepository = {
      activate: (projectId, sourcePolicy, revision) =>
        writeProjectSource(projectId, sourcePolicy, revision, "[]"),
      findByProjectId: (projectId) => {
        const source = database
          .select(selectProjectSource)
          .from(projectSourceState)
          .where(eq(projectSourceState.projectId, projectId))
          .get();
        return source === undefined ? undefined : decodeProjectSource(source);
      },
      reject: (projectId, sourcePolicy, diagnostics) =>
        writeProjectSource(projectId, sourcePolicy, null, diagnostics),
    };

    const decodeRun = (run: typeof workflowRuns.$inferSelect): StoredWorkflowRun => ({
      ...run,
      state: run.state as WorkflowRunState,
    });
    const decodeAttempt = (
      attempt: typeof executionAttempts.$inferSelect,
    ): StoredExecutionAttempt => ({ ...attempt, state: attempt.state as WorkflowRunState });
    const decodeLease = (lease: typeof executionLeases.$inferSelect): StoredExecutionLease => ({
      ...lease,
      state: lease.state as StoredExecutionLease["state"],
    });
    type StoreTransaction = Parameters<Parameters<typeof database.transaction>[0]>[0];
    const assertExecutionScope = (transaction: StoreTransaction, scope: ExecutionWriteScope) => {
      const run = transaction
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.runId, scope.runId))
        .get();
      const attempt = transaction
        .select()
        .from(executionAttempts)
        .where(
          and(
            eq(executionAttempts.runId, scope.runId),
            eq(executionAttempts.number, scope.attempt),
          ),
        )
        .get();
      const lease = transaction
        .select()
        .from(executionLeases)
        .where(
          and(
            eq(executionLeases.runId, scope.runId),
            eq(executionLeases.generation, scope.leaseGeneration),
          ),
        )
        .get();
      if (
        run?.state !== "Running" ||
        run.projectId !== scope.projectId ||
        run.rootRunId !== scope.rootRunId ||
        attempt?.state !== "Running" ||
        lease?.state !== "Active" ||
        lease.holder !== scope.leaseHolder ||
        lease.expiresAt <= new Date().toISOString()
      ) {
        throw new Error(`Workflow Run ${scope.runId} rejected a delayed execution write`);
      }
      return { attempt, lease, run };
    };
    const findEvidenceByIdempotencyKey = (
      transaction: StoreTransaction,
      runId: string,
      idempotencyKey: string,
    ) =>
      transaction
        .select()
        .from(evidenceEvents)
        .where(
          and(eq(evidenceEvents.runId, runId), eq(evidenceEvents.idempotencyKey, idempotencyKey)),
        )
        .get();
    const insertBoundary = (
      transaction: StoreTransaction,
      record: Parameters<WorkflowRunRepository["appendBoundary"]>[0],
    ): StoredEvidenceEvent => {
      const existing = findEvidenceByIdempotencyKey(
        transaction,
        record.runId,
        record.idempotencyKey,
      );
      if (existing !== undefined) {
        if (
          existing.details !== record.details ||
          existing.subject !== record.subject ||
          existing.type !== record.operation
        ) {
          throw new Error(
            `Workflow Run ${record.runId} reused durable idempotency key ${record.idempotencyKey} with different data`,
          );
        }
        return existing;
      }
      const previous = transaction
        .select({ sequence: sql<number>`max(${evidenceEvents.sequence})` })
        .from(evidenceEvents)
        .where(eq(evidenceEvents.runId, record.runId))
        .get();
      const sequence = (previous?.sequence ?? 0) + 1;
      const now = new Date().toISOString();
      const parent = transaction
        .select({ eventId: evidenceEvents.eventId })
        .from(evidenceEvents)
        .where(and(eq(evidenceEvents.runId, record.runId), eq(evidenceEvents.sequence, 1)))
        .get();
      const evidence: StoredEvidenceEvent = {
        attempt: record.attempt,
        causationId: parent?.eventId ?? null,
        details: record.details,
        eventId: randomUUID(),
        idempotencyKey: record.idempotencyKey,
        parentEventId: parent?.eventId ?? null,
        recordedAt: now,
        runId: record.runId,
        sequence,
        subject: record.subject,
        type: record.operation,
      };
      transaction
        .insert(workflowJournal)
        .values({
          attempt: record.attempt,
          idempotencyKey: record.idempotencyKey,
          operation: record.operation,
          payload: record.details,
          runId: record.runId,
          sequence,
          writtenAt: now,
        })
        .run();
      transaction.insert(evidenceEvents).values(evidence).run();
      const details = decodePayload<Record<string, unknown>>(record.details);
      const artifacts = Array.isArray(details.artifacts) ? details.artifacts : [];
      for (const artifact of artifacts) {
        if (
          typeof artifact === "object" &&
          artifact !== null &&
          typeof artifact.fingerprint === "string" &&
          typeof artifact.name === "string"
        ) {
          transaction
            .insert(evidenceArtifacts)
            .values({
              artifactFingerprint: artifact.fingerprint,
              eventId: evidence.eventId,
              name: artifact.name,
            })
            .onConflictDoNothing()
            .run();
        }
      }
      return evidence;
    };
    const lifecycleRequested = (
      transaction: StoreTransaction,
      runId: string,
      operation: "Discard" | "Suspend",
    ) => {
      const requested = transaction
        .select({ sequence: workflowJournal.sequence })
        .from(workflowJournal)
        .where(
          and(
            eq(workflowJournal.runId, runId),
            eq(workflowJournal.operation, `WorkflowRun.${operation}Requested`),
          ),
        )
        .orderBy(sql`${workflowJournal.sequence} desc`)
        .get();
      const applied = transaction
        .select({ sequence: workflowJournal.sequence })
        .from(workflowJournal)
        .where(
          and(
            eq(workflowJournal.runId, runId),
            eq(
              workflowJournal.operation,
              operation === "Suspend" ? "WorkflowRun.Suspended" : "WorkflowRun.Discarded",
            ),
          ),
        )
        .orderBy(sql`${workflowJournal.sequence} desc`)
        .get();
      return requested !== undefined && (applied?.sequence ?? 0) < requested.sequence;
    };
    const appendLifecycle = (
      transaction: StoreTransaction,
      runId: string,
      attempt: number,
      operation: string,
      detailsValue: unknown,
      options: { readonly idempotencyKey?: string; readonly subject?: string } = {},
    ) => {
      const idempotencyKey = options.idempotencyKey ?? `${runId}:${operation}:${attempt}`;
      const existing = transaction
        .select()
        .from(evidenceEvents)
        .where(
          and(eq(evidenceEvents.runId, runId), eq(evidenceEvents.idempotencyKey, idempotencyKey)),
        )
        .get();
      if (existing !== undefined) return existing;
      const previous = transaction
        .select({ sequence: sql<number>`max(${evidenceEvents.sequence})` })
        .from(evidenceEvents)
        .where(eq(evidenceEvents.runId, runId))
        .get();
      const sequence = (previous?.sequence ?? 0) + 1;
      const parentEventId =
        transaction
          .select({ eventId: evidenceEvents.eventId })
          .from(evidenceEvents)
          .where(and(eq(evidenceEvents.runId, runId), eq(evidenceEvents.sequence, 1)))
          .get()?.eventId ?? null;
      const now = new Date().toISOString();
      const details = JSON.stringify({ encodingVersion: 1, value: detailsValue });
      const event: StoredEvidenceEvent = {
        attempt,
        causationId: parentEventId,
        details,
        eventId: randomUUID(),
        idempotencyKey,
        parentEventId,
        recordedAt: now,
        runId,
        sequence,
        subject: options.subject ?? runId,
        type: operation,
      };
      transaction
        .insert(workflowJournal)
        .values({
          attempt,
          idempotencyKey: event.idempotencyKey,
          operation,
          payload: details,
          runId,
          sequence,
          writtenAt: now,
        })
        .run();
      transaction.insert(evidenceEvents).values(event).run();
      return event;
    };
    const appendUncertainActivities = (transaction: StoreTransaction, runId: string) => {
      const claims = transaction
        .select()
        .from(activityClaims)
        .where(eq(activityClaims.runId, runId))
        .all();
      const uncertain: Array<StoredEvidenceEvent> = [];
      for (const claim of claims) {
        const completed = transaction
          .select({ sequence: workflowJournal.sequence })
          .from(workflowJournal)
          .where(
            and(
              eq(workflowJournal.runId, runId),
              eq(workflowJournal.idempotencyKey, claim.completionIdempotencyKey),
            ),
          )
          .get();
        if (completed !== undefined) continue;
        const started = transaction
          .select({ eventId: evidenceEvents.eventId })
          .from(evidenceEvents)
          .where(
            and(
              eq(evidenceEvents.runId, runId),
              eq(evidenceEvents.idempotencyKey, claim.startedIdempotencyKey),
            ),
          )
          .get();
        uncertain.push(
          appendLifecycle(
            transaction,
            runId,
            claim.attempt,
            "Activity.Uncertain",
            { activityEventId: started?.eventId ?? null, subject: claim.subject },
            {
              idempotencyKey: `${claim.startedIdempotencyKey}:uncertain`,
              subject: claim.subject,
            },
          ),
        );
      }
      return uncertain;
    };
    const applyPendingLifecycle = (
      transaction: StoreTransaction,
      runId: string,
      attempt: number,
    ):
      | { readonly control: "discard" | "suspend"; readonly evidence: StoredEvidenceEvent }
      | undefined => {
      const run = transaction
        .select({ state: workflowRuns.state })
        .from(workflowRuns)
        .where(eq(workflowRuns.runId, runId))
        .get();
      if (run?.state !== "Running") return undefined;
      const control = lifecycleRequested(transaction, runId, "Discard")
        ? ("discard" as const)
        : lifecycleRequested(transaction, runId, "Suspend")
          ? ("suspend" as const)
          : undefined;
      if (control === undefined) return undefined;
      const state = control === "suspend" ? "Suspended" : "Discarded";
      const operation = `WorkflowRun.${state}`;
      const evidence = appendLifecycle(transaction, runId, attempt, operation, {
        reason: control === "suspend" ? "Requested" : "DiscardedByOperator",
      });
      transaction
        .update(workflowRuns)
        .set({ state, updatedAt: evidence.recordedAt })
        .where(eq(workflowRuns.runId, runId))
        .run();
      transaction
        .update(executionAttempts)
        .set({ finishedAt: evidence.recordedAt, state })
        .where(and(eq(executionAttempts.runId, runId), eq(executionAttempts.number, attempt)))
        .run();
      transaction
        .update(executionLeases)
        .set({ state: "Released" })
        .where(and(eq(executionLeases.runId, runId), eq(executionLeases.state, "Active")))
        .run();
      return { control, evidence };
    };
    const interruptRun = (
      runId: string,
      reason: "LeaseExpired" | "ProjectRuntimeProcessLost" | "SystemProcessRestart",
      scope?: ExecutionWriteScope,
    ) =>
      database.transaction((transaction) => {
        const run = transaction
          .select({ state: workflowRuns.state })
          .from(workflowRuns)
          .where(eq(workflowRuns.runId, runId))
          .get();
        if (run?.state !== "Running") return false;
        const attempt =
          transaction
            .select({ number: executionAttempts.number })
            .from(executionAttempts)
            .where(eq(executionAttempts.runId, runId))
            .orderBy(sql`${executionAttempts.number} desc`)
            .get()?.number ?? 1;
        if (scope !== undefined) {
          const lease = transaction
            .select()
            .from(executionLeases)
            .where(
              and(
                eq(executionLeases.runId, scope.runId),
                eq(executionLeases.generation, scope.leaseGeneration),
              ),
            )
            .get();
          if (
            attempt !== scope.attempt ||
            runId !== scope.runId ||
            lease?.state !== "Active" ||
            lease.holder !== scope.leaseHolder
          ) {
            return false;
          }
        }
        appendUncertainActivities(transaction, runId);
        const evidence = appendLifecycle(transaction, runId, attempt, "WorkflowRun.Interrupted", {
          reason,
        });
        transaction
          .update(workflowRuns)
          .set({ state: "Interrupted", updatedAt: evidence.recordedAt })
          .where(eq(workflowRuns.runId, runId))
          .run();
        transaction
          .update(executionAttempts)
          .set({ finishedAt: evidence.recordedAt, state: "Interrupted" })
          .where(and(eq(executionAttempts.runId, runId), eq(executionAttempts.number, attempt)))
          .run();
        transaction
          .update(executionLeases)
          .set({ state: "Expired" })
          .where(and(eq(executionLeases.runId, runId), eq(executionLeases.state, "Active")))
          .run();
        return true;
      });
    const reconcileExpiredScope = (scope: ExecutionWriteScope) => {
      const lease = database
        .select()
        .from(executionLeases)
        .where(
          and(
            eq(executionLeases.runId, scope.runId),
            eq(executionLeases.generation, scope.leaseGeneration),
          ),
        )
        .get();
      if (lease?.state === "Active" && lease.expiresAt <= new Date().toISOString()) {
        interruptRun(scope.runId, "LeaseExpired");
        throw new Error(`Workflow Run ${scope.runId} rejected a delayed execution write`);
      }
    };
    const workflowRunRepository: WorkflowRunRepository = {
      appendBoundary: (record) => {
        reconcileExpiredScope(record);
        return database.transaction((transaction) => {
          assertExecutionScope(transaction, record);
          const evidence = insertBoundary(transaction, record);
          const lifecycle = applyPendingLifecycle(transaction, record.runId, record.attempt);
          return lifecycle === undefined
            ? evidence
            : Object.assign(evidence, { control: lifecycle.control });
        });
      },
      claimActivity: (record) => {
        reconcileExpiredScope(record);
        return database.transaction((transaction) => {
          assertExecutionScope(transaction, record);
          const lifecycle = applyPendingLifecycle(transaction, record.runId, record.attempt);
          if (lifecycle !== undefined) {
            return {
              evidence: lifecycle.evidence,
              status: `${lifecycle.control}ed` as "discarded" | "suspended",
            } as const;
          }
          const storedClaim = transaction
            .select()
            .from(activityClaims)
            .where(
              and(
                eq(activityClaims.runId, record.runId),
                eq(activityClaims.startedIdempotencyKey, record.idempotencyKey),
              ),
            )
            .get();
          if (
            storedClaim !== undefined &&
            (storedClaim.attempt !== record.attempt ||
              storedClaim.completionIdempotencyKey !== record.completionIdempotencyKey ||
              storedClaim.subject !== record.subject)
          ) {
            throw new Error(
              `Workflow Run ${record.runId} reused Activity claim ${record.idempotencyKey} with different data`,
            );
          }
          if (storedClaim === undefined) {
            transaction
              .insert(activityClaims)
              .values({
                attempt: record.attempt,
                completionIdempotencyKey: record.completionIdempotencyKey,
                runId: record.runId,
                startedIdempotencyKey: record.idempotencyKey,
                subject: record.subject,
              })
              .run();
          }
          const completed = transaction
            .select()
            .from(workflowJournal)
            .where(
              and(
                eq(workflowJournal.runId, record.runId),
                eq(workflowJournal.idempotencyKey, record.completionIdempotencyKey),
              ),
            )
            .get();
          if (completed !== undefined) {
            if (completed.operation !== "Activity.Completed") {
              throw new Error(
                `Workflow Run ${record.runId} has invalid Activity replay journal state`,
              );
            }
            return { payload: completed.payload, status: "replay" } as const;
          }
          const existing = findEvidenceByIdempotencyKey(
            transaction,
            record.runId,
            record.idempotencyKey,
          );
          if (existing !== undefined) {
            const evidence = appendLifecycle(
              transaction,
              record.runId,
              record.attempt,
              "Activity.Uncertain",
              { activityEventId: existing.eventId, subject: record.subject },
              {
                idempotencyKey: `${record.idempotencyKey}:uncertain`,
                subject: record.subject,
              },
            );
            return { evidence, status: "uncertain" } as const;
          }
          return { evidence: insertBoundary(transaction, record), status: "execute" } as const;
        });
      },
      discard: (runId) =>
        database.transaction((transaction) => {
          const run = transaction
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.runId, runId))
            .get();
          if (run === undefined) throw new Error(`Workflow Run ${runId} was not found`);
          if (run.state === "Completed" || run.state === "Discarded") {
            throw new Error(`Workflow Run ${runId} is immutable in ${run.state} state`);
          }
          const attempt =
            transaction
              .select({ number: executionAttempts.number })
              .from(executionAttempts)
              .where(eq(executionAttempts.runId, runId))
              .orderBy(sql`${executionAttempts.number} desc`)
              .get()?.number ?? 1;
          if (run.state === "Running") {
            appendLifecycle(transaction, runId, attempt, "WorkflowRun.DiscardRequested", {});
            appendUncertainActivities(transaction, runId);
          }
          const evidence = appendLifecycle(transaction, runId, attempt, "WorkflowRun.Discarded", {
            cleanup: "BestEffort",
          });
          transaction
            .update(workflowRuns)
            .set({ state: "Discarded", updatedAt: evidence.recordedAt })
            .where(eq(workflowRuns.runId, runId))
            .run();
          if (run.state === "Running") {
            transaction
              .update(executionAttempts)
              .set({ finishedAt: evidence.recordedAt, state: "Discarded" })
              .where(and(eq(executionAttempts.runId, runId), eq(executionAttempts.number, attempt)))
              .run();
            transaction
              .update(executionLeases)
              .set({ state: "Released" })
              .where(and(eq(executionLeases.runId, runId), eq(executionLeases.state, "Active")))
              .run();
          }
          return { runId, state: "Discarded" as const, status: "discarded" as const };
        }),
      finalize: (record, scope) => {
        reconcileExpiredScope(scope);
        database.transaction((transaction) => {
          assertExecutionScope(transaction, scope);
          transaction
            .update(workflowRuns)
            .set({
              outcome: record.outcome,
              state: record.state,
              updatedAt: record.evidence.recordedAt,
            })
            .where(eq(workflowRuns.runId, record.runId))
            .run();
          transaction
            .update(executionAttempts)
            .set({ finishedAt: record.evidence.recordedAt, state: record.state })
            .where(
              and(
                eq(executionAttempts.runId, record.runId),
                eq(executionAttempts.number, record.evidence.attempt),
              ),
            )
            .run();
          transaction
            .update(executionLeases)
            .set({ state: "Released" })
            .where(
              and(
                eq(executionLeases.runId, record.runId),
                eq(executionLeases.generation, scope.leaseGeneration),
              ),
            )
            .run();
          transaction.insert(workflowJournal).values(record.journal).run();
          transaction.insert(evidenceEvents).values(record.evidence).run();
        });
      },
      find: (runId) => {
        const run = database.select().from(workflowRuns).where(eq(workflowRuns.runId, runId)).get();
        if (run === undefined) return undefined;
        const revision = database
          .select()
          .from(workflowRevisions)
          .where(eq(workflowRevisions.fingerprint, run.revisionFingerprint))
          .get();
        if (revision === undefined) {
          throw new Error(`Workflow Revision ${run.revisionFingerprint} is missing`);
        }
        return {
          attempts: database
            .select()
            .from(executionAttempts)
            .where(eq(executionAttempts.runId, runId))
            .orderBy(executionAttempts.number)
            .all()
            .map(decodeAttempt),
          evidence: database
            .select()
            .from(evidenceEvents)
            .where(eq(evidenceEvents.runId, runId))
            .orderBy(evidenceEvents.sequence)
            .all(),
          lease: (() => {
            const stored = database
              .select()
              .from(executionLeases)
              .where(eq(executionLeases.runId, runId))
              .orderBy(sql`${executionLeases.generation} desc`)
              .get();
            return stored === undefined ? undefined : decodeLease(stored);
          })(),
          revision,
          revisionSnapshot: database
            .select()
            .from(workflowRevisionSnapshots)
            .where(eq(workflowRevisionSnapshots.rootRunId, run.rootRunId))
            .get(),
          run: decodeRun(run),
        };
      },
      list: () =>
        database
          .select()
          .from(workflowRuns)
          .orderBy(workflowRuns.createdAt, workflowRuns.runId)
          .all()
          .map(decodeRun),
      interruptRunning: () => {
        const running = database
          .select({ runId: workflowRuns.runId })
          .from(workflowRuns)
          .where(eq(workflowRuns.state, "Running"))
          .all();
        for (const { runId } of running) interruptRun(runId, "SystemProcessRestart");
        return running.map(({ runId }) => runId);
      },
      interruptScope: (scope, reason) => interruptRun(scope.runId, reason, scope),
      reconcileExpiredLeases: () => {
        const now = new Date().toISOString();
        const expired = database
          .select({ runId: executionLeases.runId })
          .from(executionLeases)
          .where(
            and(eq(executionLeases.state, "Active"), sql`${executionLeases.expiresAt} <= ${now}`),
          )
          .all();
        const interrupted: Array<string> = [];
        for (const { runId } of expired) {
          if (interruptRun(runId, "LeaseExpired")) interrupted.push(runId);
        }
        return interrupted;
      },
      registerArtifact: (record) => {
        reconcileExpiredScope(record);
        database.transaction((transaction) => {
          assertExecutionScope(transaction, record);
          const existing = transaction
            .select()
            .from(executionArtifacts)
            .where(eq(executionArtifacts.fingerprint, record.fingerprint))
            .get();
          if (
            existing !== undefined &&
            (existing.byteLength !== record.byteLength ||
              existing.mediaType !== record.mediaType ||
              existing.path !== record.path)
          ) {
            throw new Error(
              `Execution Artifact ${record.fingerprint} conflicts with durable metadata`,
            );
          }
          if (existing === undefined) {
            transaction
              .insert(executionArtifacts)
              .values({
                byteLength: record.byteLength,
                createdAt: new Date().toISOString(),
                fingerprint: record.fingerprint,
                mediaType: record.mediaType,
                path: record.path,
              })
              .run();
          }
        });
      },
      requestSuspend: (runId, reason = "Operator") =>
        database.transaction((transaction) => {
          const run = transaction
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.runId, runId))
            .get();
          if (run === undefined) throw new Error(`Workflow Run ${runId} was not found`);
          if (run.state !== "Running") {
            throw new Error(`Workflow Run ${runId} cannot suspend from ${run.state} state`);
          }
          const attempt =
            transaction
              .select({ number: executionAttempts.number })
              .from(executionAttempts)
              .where(eq(executionAttempts.runId, runId))
              .orderBy(sql`${executionAttempts.number} desc`)
              .get()?.number ?? 1;
          appendLifecycle(transaction, runId, attempt, "WorkflowRun.SuspendRequested", { reason });
          return { runId, state: "Running" as const, status: "requested" as const };
        }),
      readBoundary: (scope, idempotencyKey) => {
        reconcileExpiredScope(scope);
        return database.transaction((transaction) => {
          assertExecutionScope(transaction, scope);
          return transaction
            .select()
            .from(workflowJournal)
            .where(
              and(
                eq(workflowJournal.runId, scope.runId),
                eq(workflowJournal.idempotencyKey, idempotencyKey),
              ),
            )
            .get();
        });
      },
      renewLease: (scope, expiresAt) => {
        reconcileExpiredScope(scope);
        database.transaction((transaction) => {
          assertExecutionScope(transaction, scope);
          transaction
            .update(executionLeases)
            .set({ expiresAt })
            .where(
              and(
                eq(executionLeases.runId, scope.runId),
                eq(executionLeases.generation, scope.leaseGeneration),
              ),
            )
            .run();
        });
      },
      resume: (record) => {
        database.transaction((transaction) => {
          const run = transaction
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.runId, record.runId))
            .get();
          if (run === undefined) throw new Error(`Workflow Run ${record.runId} was not found`);
          if (!["Suspended", "Interrupted", "Failed"].includes(run.state)) {
            throw new Error(`Workflow Run ${record.runId} is immutable in ${run.state} state`);
          }
          const latestAttempt =
            transaction
              .select({ number: executionAttempts.number })
              .from(executionAttempts)
              .where(eq(executionAttempts.runId, record.runId))
              .orderBy(sql`${executionAttempts.number} desc`)
              .get()?.number ?? 0;
          const latestGeneration =
            transaction
              .select({ generation: executionLeases.generation })
              .from(executionLeases)
              .where(eq(executionLeases.runId, record.runId))
              .orderBy(sql`${executionLeases.generation} desc`)
              .get()?.generation ?? 0;
          if (
            record.attempt.number !== latestAttempt + 1 ||
            record.lease.generation !== latestGeneration + 1
          ) {
            throw new Error(`Workflow Run ${record.runId} resume authority is stale`);
          }
          transaction
            .update(executionLeases)
            .set({ state: "Superseded" })
            .where(
              and(eq(executionLeases.runId, record.runId), eq(executionLeases.state, "Active")),
            )
            .run();
          transaction
            .update(workflowRuns)
            .set({ state: "Running", updatedAt: record.evidence.recordedAt })
            .where(eq(workflowRuns.runId, record.runId))
            .run();
          transaction.insert(executionAttempts).values(record.attempt).run();
          transaction.insert(executionLeases).values(record.lease).run();
          transaction.insert(workflowJournal).values(record.journal).run();
          transaction.insert(evidenceEvents).values(record.evidence).run();
        });
      },
      start: (record) => {
        database.transaction((transaction) => {
          transaction
            .insert(workflowRevisions)
            .values(record.revision)
            .onConflictDoNothing({ target: workflowRevisions.fingerprint })
            .run();
          transaction.insert(workflowRuns).values(record.run).run();
          transaction.insert(workflowRevisionSnapshots).values(record.revisionSnapshot).run();
          transaction.insert(executionAttempts).values(record.attempt).run();
          transaction.insert(executionLeases).values(record.lease).run();
          transaction.insert(workflowJournal).values(record.journal).run();
          transaction.insert(evidenceEvents).values(record.evidence).run();
        });
      },
      verifyRuntimeConfiguration: (record) => {
        reconcileExpiredScope(record);
        return database.transaction((transaction) => {
          assertExecutionScope(transaction, record);
          const existing = transaction
            .select()
            .from(runtimeConfigurationSnapshots)
            .where(
              and(
                eq(runtimeConfigurationSnapshots.runId, record.runId),
                eq(runtimeConfigurationSnapshots.subject, record.subject),
              ),
            )
            .get();
          if (existing === undefined) {
            const now = new Date().toISOString();
            transaction
              .insert(runtimeConfigurationSnapshots)
              .values({
                createdAt: now,
                runId: record.runId,
                snapshot: record.snapshot,
                subject: record.subject,
              })
              .run();
            return {
              evidence: insertBoundary(transaction, {
                ...record,
                details: record.snapshot,
                idempotencyKey: `${record.runId}:runtime-configuration:${record.subject}:snapshot`,
                operation: "RuntimeConfiguration.SnapshotRecorded",
              }),
              status: "recorded" as const,
            };
          }
          const status = existing.snapshot === record.snapshot ? "compatible" : "incompatible";
          return {
            evidence: insertBoundary(transaction, {
              ...record,
              details:
                status === "compatible"
                  ? record.snapshot
                  : encodePayload({
                      available: decodePayload(record.snapshot),
                      expected: decodePayload(existing.snapshot),
                    }),
              idempotencyKey: `${record.runId}:runtime-configuration:${record.subject}:${record.attempt}:${status}`,
              operation:
                status === "compatible"
                  ? "RuntimeConfiguration.Compatible"
                  : "RuntimeConfiguration.Incompatible",
            }),
            status,
          };
        });
      },
    };
    const workflowJournalRepository: WorkflowJournalRepository = {
      list: (runId) =>
        database
          .select()
          .from(workflowJournal)
          .where(eq(workflowJournal.runId, runId))
          .orderBy(workflowJournal.sequence)
          .all(),
    };

    return {
      close: () => sqlite.close(),
      projects: projectRepository,
      projectSources: projectSourceRepository,
      workflowJournal: workflowJournalRepository,
      workflowRuns: workflowRunRepository,
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
};
