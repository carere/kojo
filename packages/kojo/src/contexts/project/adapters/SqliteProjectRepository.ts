import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type {
  ProjectDocument,
  ProjectLocationAction,
  ProjectLocationRecord,
  ProjectLocationResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type { WorkflowDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { Effect, Layer } from "effect";
import type { FactoryRefreshObservation } from "../../workflow/models/FactoryRefresh.ts";
import type {
  TriggerPoller,
  WorkflowActivityReceipt,
} from "../../workflow/models/WorkflowActivity.ts";
import type { RegisteredProject, RegisterProjectRequest } from "../models/Project.ts";
import { ProjectStoreError } from "../models/ProjectStoreError.ts";
import { ProjectRepository } from "../ports/ProjectRepository.ts";

interface ProjectRow {
  readonly project_id: string;
  readonly location: string;
  readonly project_state: "available" | "unavailable" | "archived";
  readonly factory_state: "missing" | "invalid" | "available";
  readonly refresh_state: "pending" | "refreshing" | "failed" | "current";
  readonly registered_at: string;
  readonly refreshed_at: string;
  readonly fault: string | null;
  readonly remedy: string | null;
  readonly last_location: string | null;
  readonly location_active: number;
  readonly location_confirmed: number;
  readonly location_action: ProjectLocationAction | null;
  readonly requested_location: string | null;
  readonly location_change_started_at: string | null;
}

interface LocationHistoryRow {
  readonly location: string;
  readonly active_from: string;
  readonly released_at: string | null;
  readonly release_reason: "relocated" | "archived" | null;
}

interface WorkflowRow {
  readonly project_id: string;
  readonly workflow_name: string;
  readonly activity: "active" | "inactive";
  readonly availability: "available" | "invalid" | "removed";
  readonly source: string;
  readonly source_fault: string | null;
  readonly remedy: string | null;
  readonly current_revision_id: string | null;
  readonly current_package_graph_id: string | null;
  readonly candidate_revision_id: string | null;
  readonly trigger_state: "not-declared" | "not-observed" | "polling" | "delayed" | "failed";
  readonly trigger_observed_at: string | null;
  readonly trigger_detail: string | null;
  readonly refreshed_at: string;
  readonly label: string;
  readonly project_state: "available" | "unavailable" | "archived";
  readonly factory_state: "missing" | "invalid" | "available";
  readonly refresh_state: "pending" | "refreshing" | "failed" | "current";
}

interface ReceiptRow {
  readonly request_body: string;
  readonly receipt_json: string;
}

interface CurrentRunRow {
  readonly run_id: string;
  readonly state: "queued" | "executing" | "suspended";
  readonly queue_reason:
    | "execution-capacity"
    | "project-capacity"
    | "runner-starting"
    | "package-switch"
    | null;
}

const projectColumns = `project_id, location, project_state, factory_state, refresh_state,
  registered_at, refreshed_at, fault, remedy, last_location, location_active,
  location_confirmed, location_action, requested_location, location_change_started_at`;

export interface ExecutionRevision {
  readonly projectId: string;
  readonly location: string;
  readonly workflowName: string;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly publishedPath: string;
  readonly entrySource: string;
}

const documentOf = (
  row: ProjectRow,
  locationHistory: ReadonlyArray<ProjectLocationRecord> = [],
): ProjectDocument => ({
  projectId: row.project_id,
  label: basename(row.last_location ?? row.location),
  location: row.last_location ?? row.location,
  locationActive: row.location_active === 1,
  locationConfirmed: row.location_confirmed === 1,
  projectState: row.project_state,
  factoryState: row.factory_state,
  refreshState: row.refresh_state,
  registeredAt: row.registered_at,
  refreshedAt: row.refreshed_at,
  locationChange:
    row.location_action === null
      ? { state: "steady" }
      : {
          state: "draining",
          action: row.location_action,
          ...(row.requested_location === null ? {} : { requestedLocation: row.requested_location }),
          ...(row.location_change_started_at === null
            ? {}
            : { startedAt: row.location_change_started_at }),
        },
  locationHistory,
  ...(row.fault === null ? {} : { fault: row.fault }),
  ...(row.remedy === null ? {} : { remedy: row.remedy }),
});

const workflowDocumentOf = (row: WorkflowRow): WorkflowDocument => ({
  projectId: row.project_id,
  projectLabel: row.label,
  projectState: row.project_state,
  factoryState: row.factory_state,
  refreshState: row.refresh_state,
  workflowName: row.workflow_name,
  activity: row.activity,
  availability: row.availability,
  source: row.source,
  ...(row.source_fault === null ? {} : { sourceFault: row.source_fault }),
  ...(row.remedy === null ? {} : { remedy: row.remedy }),
  ...(row.current_revision_id === null ? {} : { currentRevisionId: row.current_revision_id }),
  ...(row.current_package_graph_id === null
    ? {}
    : { currentPackageGraphId: row.current_package_graph_id }),
  ...(row.candidate_revision_id === null ? {} : { candidateRevisionId: row.candidate_revision_id }),
  trigger: {
    state: row.trigger_state,
    ...(row.trigger_observed_at === null ? {} : { observedAt: row.trigger_observed_at }),
    ...(row.trigger_detail === null ? {} : { detail: row.trigger_detail }),
  },
  currentRuns: [],
  refreshedAt: row.refreshed_at,
});

const failed = (cause: unknown): ProjectStoreError =>
  cause instanceof ProjectStoreError
    ? cause
    : new ProjectStoreError({
        code: "PROJECT_STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        status: 500,
        retry: "safe",
        remedy: "Run `kojo daemon status`, then retry the original request.",
        cause,
      });

export class SqliteProjectRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY NOT NULL,
        location TEXT NOT NULL UNIQUE,
        project_state TEXT NOT NULL CHECK(project_state IN ('available', 'unavailable', 'archived')),
        factory_state TEXT NOT NULL CHECK(factory_state IN ('missing', 'invalid', 'available')),
        refresh_state TEXT NOT NULL DEFAULT 'current' CHECK(refresh_state IN ('pending', 'refreshing', 'failed', 'current')),
        registered_at TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        fault TEXT,
        remedy TEXT
      ) STRICT
    `);
    const projectColumnInfo = database
      .query<{ readonly name: string }, []>("PRAGMA table_info(projects)")
      .all();
    if (!projectColumnInfo.some((column) => column.name === "refresh_state")) {
      database.run("ALTER TABLE projects ADD COLUMN refresh_state TEXT NOT NULL DEFAULT 'current'");
    }
    const additions = [
      ["last_location", "TEXT"],
      ["location_active", "INTEGER NOT NULL DEFAULT 1"],
      ["location_confirmed", "INTEGER NOT NULL DEFAULT 1"],
      ["location_action", "TEXT"],
      ["requested_location", "TEXT"],
      ["location_change_started_at", "TEXT"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!projectColumnInfo.some((column) => column.name === name)) {
        database.run(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
      }
    }
    database.run("UPDATE projects SET last_location = location WHERE last_location IS NULL");
    database.run(`
      CREATE TABLE IF NOT EXISTS project_location_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        location TEXT NOT NULL,
        active_from TEXT NOT NULL,
        released_at TEXT,
        release_reason TEXT CHECK(release_reason IN ('relocated', 'archived')),
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      ) STRICT
    `);
    database.run(`
      INSERT INTO project_location_history (project_id, location, active_from)
      SELECT p.project_id, p.last_location, p.registered_at FROM projects p
       WHERE NOT EXISTS (
         SELECT 1 FROM project_location_history h WHERE h.project_id = p.project_id
       )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_revisions (
        revision_id TEXT PRIMARY KEY NOT NULL,
        package_graph_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        published_path TEXT NOT NULL,
        published_at TEXT NOT NULL
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS project_workflows (
        project_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        activity TEXT NOT NULL CHECK(activity IN ('active', 'inactive')),
        availability TEXT NOT NULL CHECK(availability IN ('available', 'invalid', 'removed')),
        source TEXT NOT NULL,
        source_fault TEXT,
        remedy TEXT,
        current_revision_id TEXT,
        candidate_revision_id TEXT,
        trigger_state TEXT NOT NULL CHECK(trigger_state IN ('not-declared', 'not-observed', 'polling', 'delayed', 'failed')),
        trigger_observed_at TEXT,
        trigger_detail TEXT,
        refreshed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, workflow_name),
        FOREIGN KEY (project_id) REFERENCES projects(project_id),
        FOREIGN KEY (current_revision_id) REFERENCES workflow_revisions(revision_id),
        FOREIGN KEY (candidate_revision_id) REFERENCES workflow_revisions(revision_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS client_receipts (
        data_identity TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_body TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (data_identity, request_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_revision_registrations (
        project_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        package_graph_id TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (project_id, workflow_name, revision_id, package_graph_id),
        FOREIGN KEY (project_id, workflow_name)
          REFERENCES project_workflows(project_id, workflow_name),
        FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_activity_receipts (
        data_identity TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (data_identity, request_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS trigger_pollers (
        project_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        poller_id TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        PRIMARY KEY (project_id, workflow_name),
        FOREIGN KEY (project_id, workflow_name) REFERENCES project_workflows(project_id, workflow_name)
      ) STRICT
    `);
    database.run(
      "INSERT OR IGNORE INTO daemon_metadata (name, value) VALUES ('project_snapshot_version', '0')",
    );
  }

  #applyFactory(
    projectId: string,
    factory: RegisterProjectRequest["factory"],
    observedAt: string,
  ): void {
    this.#database.run(
      `UPDATE projects
          SET factory_state = ?, refresh_state = ?, refreshed_at = ?, fault = ?, remedy = ?
        WHERE project_id = ?`,
      [
        factory.state,
        factory.refreshState ?? "current",
        observedAt,
        factory.fault ?? null,
        factory.remedy ?? null,
        projectId,
      ],
    );
    const currentNames = new Set(
      (factory.workflows ?? []).map((workflow) => workflow.workflowName),
    );
    const priorNames = this.#database
      .query<{ readonly workflow_name: string }, [string]>(
        "SELECT workflow_name FROM project_workflows WHERE project_id = ?",
      )
      .all(projectId);
    for (const prior of priorNames) {
      if (!currentNames.has(prior.workflow_name)) {
        this.#database.run(
          `UPDATE project_workflows
              SET availability = 'removed', candidate_revision_id = NULL,
                  source_fault = NULL, remedy = NULL, refreshed_at = ?
            WHERE project_id = ? AND workflow_name = ?`,
          [observedAt, projectId, prior.workflow_name],
        );
      }
    }
    for (const workflow of factory.workflows ?? []) {
      const revision = workflow.revision;
      if (revision !== undefined) {
        this.#database.run(
          `INSERT OR IGNORE INTO workflow_revisions (
             revision_id, package_graph_id, manifest_json, published_path, published_at
           ) VALUES (?, ?, ?, ?, ?)`,
          [
            revision.revisionId,
            revision.packageGraphId,
            JSON.stringify(revision.manifest),
            revision.publishedPath,
            observedAt,
          ],
        );
      }
      this.#database.run(
        `INSERT INTO project_workflows (
           project_id, workflow_name, activity, availability, source, source_fault, remedy,
           current_revision_id, candidate_revision_id, trigger_state, refreshed_at
         ) VALUES (?, ?, 'inactive', ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(project_id, workflow_name) DO UPDATE SET
           availability = excluded.availability,
           source = excluded.source,
           source_fault = excluded.source_fault,
           remedy = excluded.remedy,
           current_revision_id = CASE
             WHEN excluded.availability = 'available' THEN excluded.current_revision_id
             ELSE project_workflows.current_revision_id
           END,
           candidate_revision_id = NULL,
           refreshed_at = excluded.refreshed_at`,
        [
          projectId,
          workflow.workflowName,
          workflow.availability,
          workflow.source,
          workflow.sourceFault ?? null,
          workflow.remedy ?? null,
          revision?.revisionId ?? null,
          workflow.triggerDeclared === true ? "not-observed" : "not-declared",
          observedAt,
        ],
      );
      if (revision !== undefined) {
        this.#database.run(
          `INSERT OR IGNORE INTO workflow_revision_registrations (
             project_id, workflow_name, revision_id, package_graph_id, registered_at
           ) VALUES (?, ?, ?, ?, ?)`,
          [
            projectId,
            workflow.workflowName,
            revision.revisionId,
            revision.packageGraphId,
            observedAt,
          ],
        );
      }
    }
  }

  #history(projectId: string): ReadonlyArray<ProjectLocationRecord> {
    return this.#database
      .query<LocationHistoryRow, [string]>(
        `SELECT location, active_from, released_at, release_reason
           FROM project_location_history WHERE project_id = ? ORDER BY active_from, history_id`,
      )
      .all(projectId)
      .map((row) => ({
        location: row.location,
        activeFrom: row.active_from,
        ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
        ...(row.release_reason === null ? {} : { releaseReason: row.release_reason }),
      }));
  }

  #project(projectId: string): ProjectRow | null {
    return this.#database
      .query<ProjectRow, [string]>(`SELECT ${projectColumns} FROM projects WHERE project_id = ?`)
      .get(projectId);
  }

  readonly register = (
    request: RegisterProjectRequest,
  ): Effect.Effect<RegisteredProject, ProjectStoreError> =>
    Effect.try({
      try: () => {
        const commit = this.#database.transaction((): RegisteredProject => {
          const prior = this.#database
            .query<ReceiptRow, [string, string]>(
              "SELECT request_body, receipt_json FROM client_receipts WHERE data_identity = ? AND request_id = ?",
            )
            .get(request.dataIdentity, request.requestId);
          if (prior !== null) {
            if (prior.request_body !== request.requestBody) {
              throw new ProjectStoreError({
                code: "REQUEST_ID_CONFLICT",
                message: "This request ID already names different request content.",
                status: 409,
                retry: "lookupOriginal",
                remedy: "Look up the original request. Use a new request ID for different content.",
              });
            }
            const receipt = JSON.parse(prior.receipt_json) as OperationReceipt;
            const result = receipt.result as unknown as {
              readonly created: boolean;
              readonly project: ProjectDocument;
            };
            return { project: result.project, created: result.created };
          }

          let row = this.#database
            .query<ProjectRow, [string]>(
              `SELECT ${projectColumns}
                 FROM projects WHERE location = ? AND project_state != 'archived'`,
            )
            .get(request.location);
          const created = row === null;
          if (row === null) {
            const projectId = crypto.randomUUID();
            this.#database.run(
              `INSERT INTO projects (
                 project_id, location, project_state, factory_state, registered_at,
                 refresh_state, refreshed_at, fault, remedy, last_location,
                 location_active, location_confirmed
               ) VALUES (?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
              [
                projectId,
                request.location,
                request.factory.state,
                request.observedAt,
                request.factory.refreshState ?? "current",
                request.observedAt,
                request.factory.fault ?? null,
                request.factory.remedy ?? null,
                request.location,
              ],
            );
            this.#database.run(
              "INSERT INTO project_location_history (project_id, location, active_from) VALUES (?, ?, ?)",
              [projectId, request.location, request.observedAt],
            );
            this.#database.run(
              "UPDATE daemon_metadata SET value = CAST(value AS INTEGER) + 1 WHERE name = 'project_snapshot_version'",
            );
            row = this.#database
              .query<ProjectRow, [string]>(
                `SELECT ${projectColumns} FROM projects WHERE project_id = ?`,
              )
              .get(projectId);
          }
          if (row === null) throw new Error("the committed Project could not be read");
          if (created) {
            this.#applyFactory(row.project_id, request.factory, request.observedAt);
            row = this.#database
              .query<ProjectRow, [string]>(
                `SELECT ${projectColumns} FROM projects WHERE project_id = ?`,
              )
              .get(row.project_id);
          }
          if (row === null) throw new Error("the refreshed Project could not be read");
          const project = documentOf(row, this.#history(row.project_id));
          const receipt: OperationReceipt = {
            receiptVersion: 1,
            requestId: request.requestId,
            dataIdentity: request.dataIdentity,
            operation: "registerProject",
            status: "committed",
            result: JSON.parse(JSON.stringify({ created, project })),
          };
          this.#database.run(
            `INSERT INTO client_receipts (
               data_identity, request_id, request_body, receipt_json, committed_at
             ) VALUES (?, ?, ?, ?, ?)`,
            [
              request.dataIdentity,
              request.requestId,
              request.requestBody,
              JSON.stringify(receipt),
              request.observedAt,
            ],
          );
          return { project, created };
        });
        return commit.immediate();
      },
      catch: failed,
    });

  readonly markMissingLocations = (
    missingLocations: ReadonlyArray<string>,
    observedAt: string,
  ): Effect.Effect<number, ProjectStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            let changed = 0;
            for (const location of missingLocations) {
              const result = this.#database.run(
                `UPDATE projects
                    SET project_state = 'unavailable', location_confirmed = 0,
                        refreshed_at = ?, fault = 'The confirmed Project location is unavailable.',
                        remedy = 'Restore the working tree, then explicitly relocate this Project to the same path.'
                  WHERE location = ? AND project_state = 'available'`,
                [observedAt, location],
              );
              if (result.changes === 0) continue;
              changed += result.changes;
              this.#database.run(
                `UPDATE project_workflows SET activity = 'inactive',
                   trigger_state = CASE WHEN trigger_state = 'not-declared' THEN 'not-declared' ELSE 'not-observed' END,
                   trigger_detail = CASE WHEN trigger_state = 'not-declared' THEN NULL ELSE 'Project location unavailable' END
                 WHERE project_id IN (SELECT project_id FROM projects WHERE location = ?)`,
                [location],
              );
              this.#database.run(
                "DELETE FROM trigger_pollers WHERE project_id IN (SELECT project_id FROM projects WHERE location = ?)",
                [location],
              );
            }
            if (changed > 0) {
              this.#database.run(
                "UPDATE daemon_metadata SET value = CAST(value AS INTEGER) + 1 WHERE name = 'project_snapshot_version'",
              );
            }
            return changed;
          })
          .immediate(),
      catch: failed,
    });

  readonly beginLocationChange = (request: {
    readonly requestId: string;
    readonly requestBody: string;
    readonly dataIdentity: string;
    readonly projectId: string;
    readonly action: ProjectLocationAction;
    readonly requestedLocation?: string;
    readonly changedAt: string;
  }): Effect.Effect<OperationReceipt, ProjectStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const priorReceipt = this.#database
              .query<ReceiptRow, [string, string]>(
                "SELECT request_body, receipt_json FROM client_receipts WHERE data_identity = ? AND request_id = ?",
              )
              .get(request.dataIdentity, request.requestId);
            if (priorReceipt !== null) {
              if (priorReceipt.request_body !== request.requestBody) {
                throw new ProjectStoreError({
                  code: "REQUEST_ID_CONFLICT",
                  message: "This request ID already names different request content.",
                  status: 409,
                  retry: "lookupOriginal",
                  remedy:
                    "Look up the original request. Use a new request ID for different content.",
                });
              }
              return JSON.parse(priorReceipt.receipt_json) as OperationReceipt;
            }
            const project = this.#project(request.projectId);
            if (project === null) {
              throw new ProjectStoreError({
                code: "PROJECT_NOT_FOUND",
                message: "The selected Project does not exist.",
                status: 404,
                retry: "never",
                remedy: "Select a Project from the authoritative Project snapshot.",
              });
            }
            if (project.location_action !== null) {
              throw new ProjectStoreError({
                code: "PROJECT_LOCATION_CHANGE_ACTIVE",
                message: "A Project location change is already draining execution.",
                status: 409,
                retry: "safe",
                remedy:
                  "Inspect the Project and retry the original request after its drain finishes.",
              });
            }
            if (request.action === "restore" && project.project_state !== "archived") {
              throw new ProjectStoreError({
                code: "PROJECT_NOT_ARCHIVED",
                message: "Only an Archived Project can be restored.",
                status: 409,
                retry: "never",
                remedy: "Select an Archived Project.",
              });
            }
            if (request.action !== "restore" && project.project_state === "archived") {
              throw new ProjectStoreError({
                code: "PROJECT_ARCHIVED",
                message: "The selected Project is Archived.",
                status: 409,
                retry: "never",
                remedy: "Restore the Project before you relocate it.",
              });
            }
            if (request.action !== "archive" && request.requestedLocation === undefined) {
              throw new ProjectStoreError({
                code: "PROJECT_LOCATION_REQUIRED",
                message: "This location change needs one exact Project location.",
                status: 422,
                retry: "never",
                remedy: "Supply one canonical Git working-tree root.",
              });
            }
            if (request.requestedLocation !== undefined) {
              const conflict = this.#database
                .query<{ readonly project_id: string }, [string, string]>(
                  `SELECT project_id FROM projects
                    WHERE location = ? AND project_id != ? AND project_state != 'archived'`,
                )
                .get(request.requestedLocation, request.projectId);
              if (conflict !== null) {
                throw new ProjectStoreError({
                  code: "PROJECT_LOCATION_CONFLICT",
                  message: "The requested location belongs to another active Project.",
                  status: 409,
                  retry: "never",
                  remedy: "Archive or relocate the other Project, or select another working tree.",
                });
              }
            }
            this.#database.run(
              `UPDATE projects SET location_action = ?, requested_location = ?,
                 location_change_started_at = ? WHERE project_id = ?`,
              [
                request.action,
                request.requestedLocation ?? null,
                request.changedAt,
                request.projectId,
              ],
            );
            this.#database.run(
              `UPDATE project_workflows SET activity = 'inactive',
                 trigger_state = CASE WHEN trigger_state = 'not-declared' THEN 'not-declared' ELSE 'not-observed' END,
                 trigger_observed_at = ?,
                 trigger_detail = CASE WHEN trigger_state = 'not-declared' THEN NULL ELSE 'Project location change draining' END
               WHERE project_id = ?`,
              [request.changedAt, request.projectId],
            );
            this.#database.run("DELETE FROM trigger_pollers WHERE project_id = ?", [
              request.projectId,
            ]);
            this.#database.run(
              "UPDATE daemon_metadata SET value = CAST(value AS INTEGER) + 1 WHERE name = 'project_snapshot_version'",
            );
            const receipt: OperationReceipt = {
              receiptVersion: 1,
              requestId: request.requestId,
              dataIdentity: request.dataIdentity,
              operation: `${request.action}Project`,
              status: "accepted",
              result: {
                action: request.action,
                projectId: request.projectId,
                priorLocation: project.last_location ?? project.location,
                ...(request.requestedLocation === undefined
                  ? {}
                  : { requestedLocation: request.requestedLocation }),
                state: "draining",
              },
            };
            this.#database.run(
              `INSERT INTO client_receipts
                 (data_identity, request_id, request_body, receipt_json, committed_at)
               VALUES (?, ?, ?, ?, ?)`,
              [
                request.dataIdentity,
                request.requestId,
                request.requestBody,
                JSON.stringify(receipt),
                request.changedAt,
              ],
            );
            return receipt;
          })
          .immediate(),
      catch: failed,
    });

  readonly commitLocationChange = (request: {
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly projectId: string;
    readonly action: ProjectLocationAction;
    readonly changedAt: string;
  }): Effect.Effect<ProjectLocationResult, ProjectStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const row = this.#project(request.projectId);
            if (row === null || row.location_action !== request.action) {
              throw new ProjectStoreError({
                code: "PROJECT_LOCATION_CHANGE_LOST",
                message: "The accepted Project location change is not active.",
                status: 409,
                retry: "lookupOriginal",
                remedy: "Look up the original request before you send another location change.",
              });
            }
            const priorLocation = row.last_location ?? row.location;
            const requested = row.requested_location;
            if (request.action === "archive") {
              this.#database.run(
                `UPDATE projects SET location = ?, project_state = 'archived', location_active = 0,
                   location_confirmed = 0, location_action = NULL, requested_location = NULL,
                   location_change_started_at = NULL, refreshed_at = ?, fault = NULL, remedy = NULL
                 WHERE project_id = ?`,
                [`/.kojo-archived/${request.projectId}`, request.changedAt, request.projectId],
              );
              this.#database.run(
                `UPDATE project_location_history SET released_at = ?, release_reason = 'archived'
                  WHERE project_id = ? AND released_at IS NULL`,
                [request.changedAt, request.projectId],
              );
            } else {
              if (requested === null) throw new Error("the accepted location was not retained");
              if (requested !== priorLocation) {
                this.#database.run(
                  `UPDATE project_location_history SET released_at = ?, release_reason = 'relocated'
                    WHERE project_id = ? AND released_at IS NULL`,
                  [request.changedAt, request.projectId],
                );
                this.#database.run(
                  `INSERT INTO project_location_history (project_id, location, active_from)
                   VALUES (?, ?, ?)`,
                  [request.projectId, requested, request.changedAt],
                );
              }
              this.#database.run(
                `UPDATE projects SET location = ?, last_location = ?, project_state = 'available',
                   location_active = 1, location_confirmed = 1, refresh_state = 'pending',
                   location_action = NULL, requested_location = NULL,
                   location_change_started_at = NULL, refreshed_at = ?, fault = NULL, remedy = NULL
                 WHERE project_id = ?`,
                [requested, requested, request.changedAt, request.projectId],
              );
            }
            this.#database.run(
              "UPDATE daemon_metadata SET value = CAST(value AS INTEGER) + 1 WHERE name = 'project_snapshot_version'",
            );
            const committed = this.#project(request.projectId);
            if (committed === null) throw new Error("the committed Project could not be read");
            const consequences = [
              "New Project dispatch stopped before the location changed.",
              "All Project Workflows are inactive.",
              "Existing Runs and pinned Workflow Revisions were retained.",
              ...(request.action === "archive"
                ? ["The prior location is released for ordinary registration."]
                : ["A Factory Refresh is required before new Runs can start."]),
            ];
            const result: ProjectLocationResult = {
              action: request.action,
              project: documentOf(committed, this.#history(request.projectId)),
              priorLocation,
              consequences,
            };
            const receipt = this.#database
              .query<ReceiptRow, [string, string]>(
                "SELECT request_body, receipt_json FROM client_receipts WHERE data_identity = ? AND request_id = ?",
              )
              .get(request.dataIdentity, request.requestId);
            if (receipt === null) throw new Error("the accepted client request was not retained");
            const committedReceipt: OperationReceipt = {
              receiptVersion: 1,
              requestId: request.requestId,
              dataIdentity: request.dataIdentity,
              operation: `${request.action}Project`,
              status: "committed",
              result: JSON.parse(JSON.stringify(result)),
            };
            this.#database.run(
              `UPDATE client_receipts SET receipt_json = ?, committed_at = ?
                WHERE data_identity = ? AND request_id = ?`,
              [
                JSON.stringify(committedReceipt),
                request.changedAt,
                request.dataIdentity,
                request.requestId,
              ],
            );
            return result;
          })
          .immediate(),
      catch: failed,
    });

  readonly projects: Effect.Effect<ReadonlyArray<ProjectDocument>, ProjectStoreError> = Effect.try({
    try: () => {
      const rows = this.#database
        .query<ProjectRow, []>(
          `SELECT ${projectColumns} FROM projects ORDER BY registered_at, project_id`,
        )
        .all();
      const documents = rows.map((row) => documentOf(row, this.#history(row.project_id)));
      const labelCounts = new Map<string, number>();
      for (const project of documents) {
        labelCounts.set(project.label, (labelCounts.get(project.label) ?? 0) + 1);
      }
      return documents.map((project) =>
        (labelCounts.get(project.label) ?? 0) > 1
          ? { ...project, label: `${project.label} · ${project.projectId.slice(0, 8)}` }
          : project,
      );
    },
    catch: failed,
  });

  readonly activeProjects: Effect.Effect<
    ReadonlyArray<{ readonly projectId: string; readonly location: string }>,
    ProjectStoreError
  > = Effect.try({
    try: () =>
      this.#database
        .query<{ readonly projectId: string; readonly location: string }, []>(
          `SELECT project_id AS projectId, location
             FROM projects WHERE project_state = 'available' ORDER BY registered_at, project_id`,
        )
        .all(),
    catch: failed,
  });

  readonly markRefreshPending = (projectId: string): Effect.Effect<void, ProjectStoreError> =>
    Effect.try({
      try: () => {
        const commit = this.#database.transaction(() => {
          this.#database.run("UPDATE projects SET refresh_state = 'pending' WHERE project_id = ?", [
            projectId,
          ]);
          this.#database.run(
            "UPDATE daemon_metadata SET value = CAST(value AS INTEGER) + 1 WHERE name = 'project_snapshot_version'",
          );
        });
        commit.immediate();
      },
      catch: failed,
    });

  readonly refresh = (
    projectId: string,
    factory: FactoryRefreshObservation,
    refreshState: "current" | "failed" | "pending",
    observedAt: string,
  ): Effect.Effect<void, ProjectStoreError> =>
    Effect.try({
      try: () => {
        const commit = this.#database.transaction(() => {
          if (refreshState === "current") {
            this.#applyFactory(
              projectId,
              {
                state: factory.factoryState,
                refreshState,
                workflows: factory.workflows,
                ...(factory.fault === undefined ? {} : { fault: factory.fault }),
                ...(factory.remedy === undefined ? {} : { remedy: factory.remedy }),
              },
              observedAt,
            );
          } else {
            this.#database.run(
              `UPDATE projects
                  SET refresh_state = ?, refreshed_at = ?, fault = ?, remedy = ?
                WHERE project_id = ?`,
              [refreshState, observedAt, factory.fault ?? null, factory.remedy ?? null, projectId],
            );
          }
          this.#database.run(
            "UPDATE daemon_metadata SET value = CAST(value AS INTEGER) + 1 WHERE name = 'project_snapshot_version'",
          );
        });
        commit.immediate();
      },
      catch: failed,
    });

  readonly workflows: Effect.Effect<ReadonlyArray<WorkflowDocument>, ProjectStoreError> =
    Effect.try({
      try: () => {
        const rows = this.#database
          .query<WorkflowRow, []>(
            `SELECT w.project_id, w.workflow_name, w.activity, w.availability, w.source,
                  w.source_fault, w.remedy, w.current_revision_id, w.candidate_revision_id,
                  w.trigger_state, w.trigger_observed_at, w.trigger_detail, w.refreshed_at,
                  r.package_graph_id AS current_package_graph_id,
                  COALESCE(p.last_location, p.location) AS label,
                  p.project_state, p.factory_state, p.refresh_state
             FROM project_workflows w
             JOIN projects p ON p.project_id = w.project_id
             LEFT JOIN workflow_revisions r ON r.revision_id = w.current_revision_id
            ORDER BY p.registered_at, w.workflow_name`,
          )
          .all();
        const labelCounts = new Map<string, number>();
        for (const row of rows) {
          const label = basename(row.label);
          labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        }
        const runTableExists =
          this.#database
            .query<{ readonly count: number }, []>(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'",
            )
            .get()?.count === 1;
        return rows.map((row) => {
          const document = workflowDocumentOf({
            ...row,
            label:
              (labelCounts.get(basename(row.label)) ?? 0) > 1
                ? `${basename(row.label)} · ${row.project_id.slice(0, 8)}`
                : basename(row.label),
          });
          if (!runTableExists) return document;
          const currentRuns = this.#database
            .query<CurrentRunRow, [string, string]>(
              `SELECT r.run_id, r.state, q.queue_reason
                 FROM workflow_runs r
                 LEFT JOIN workflow_queue q ON q.run_id = r.run_id
                WHERE r.project_id = ? AND r.workflow_name = ?
                  AND r.state IN ('queued', 'executing', 'suspended')
                ORDER BY r.admission_sequence`,
            )
            .all(row.project_id, row.workflow_name)
            .map((run) => ({
              runId: run.run_id,
              state: run.state,
              ...(run.queue_reason === null ? {} : { queueReason: run.queue_reason }),
            }));
          return { ...document, currentRuns };
        });
      },
      catch: failed,
    });

  readonly workflow = (
    projectId: string,
    workflowName: string,
  ): Effect.Effect<WorkflowDocument | undefined, ProjectStoreError> =>
    Effect.map(this.workflows, (workflows) =>
      workflows.find(
        (workflow) => workflow.projectId === projectId && workflow.workflowName === workflowName,
      ),
    );

  readonly startActivity = (request: {
    readonly dataIdentity: string;
    readonly requestId: string;
    readonly projectId: string;
    readonly workflowName: string;
    readonly changedAt: string;
  }): Effect.Effect<WorkflowActivityReceipt, ProjectStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const requestJson = JSON.stringify([request.projectId, request.workflowName, "start"]);
            const prior = this.#database
              .query<
                { readonly request_json: string; readonly receipt_json: string },
                [string, string]
              >(
                "SELECT request_json, receipt_json FROM workflow_activity_receipts WHERE data_identity = ? AND request_id = ?",
              )
              .get(request.dataIdentity, request.requestId);
            if (prior !== null) {
              if (prior.request_json !== requestJson) {
                throw new ProjectStoreError({
                  code: "REQUEST_ID_CONFLICT",
                  message: "This request ID already names different request content.",
                  status: 409,
                  retry: "lookupOriginal",
                  remedy: "Look up the original request.",
                });
              }
              return JSON.parse(prior.receipt_json) as WorkflowActivityReceipt;
            }
            const workflow = this.#workflowRow(request.projectId, request.workflowName);
            if (workflow.availability !== "available" || workflow.current_revision_id === null) {
              throw new ProjectStoreError({
                code: "WORKFLOW_UNAVAILABLE",
                message: "The selected Project Workflow is not available.",
                status: 409,
                retry: "never",
                remedy: "Repair the Workflow fault shown in its snapshot.",
              });
            }
            const trigger = workflow.trigger_state !== "not-declared";
            let pollerStarted = false;
            let pollerId: string | undefined;
            if (trigger) {
              const priorPoller = this.#database
                .query<{ readonly poller_id: string }, [string, string]>(
                  "SELECT poller_id FROM trigger_pollers WHERE project_id = ? AND workflow_name = ?",
                )
                .get(request.projectId, request.workflowName);
              pollerId = priorPoller?.poller_id ?? crypto.randomUUID();
              if (priorPoller === null) {
                this.#database.run(
                  "INSERT INTO trigger_pollers (project_id, workflow_name, poller_id, started_at) VALUES (?, ?, ?, ?)",
                  [request.projectId, request.workflowName, pollerId, request.changedAt],
                );
                pollerStarted = true;
              }
              this.#database.run(
                `UPDATE project_workflows
                    SET activity = 'active', trigger_state = 'polling',
                        trigger_observed_at = ?, trigger_detail = 'listening'
                  WHERE project_id = ? AND workflow_name = ?`,
                [request.changedAt, request.projectId, request.workflowName],
              );
            } else {
              this.#database.run(
                "UPDATE project_workflows SET activity = 'active' WHERE project_id = ? AND workflow_name = ?",
                [request.projectId, request.workflowName],
              );
            }
            const receipt: WorkflowActivityReceipt = {
              projectId: request.projectId,
              workflowName: request.workflowName,
              activity: "active",
              trigger,
              pollerStarted,
              ...(pollerId === undefined ? {} : { pollerId }),
              changedAt: request.changedAt,
            };
            this.#database.run(
              "INSERT INTO workflow_activity_receipts (data_identity, request_id, request_json, receipt_json, committed_at) VALUES (?, ?, ?, ?, ?)",
              [
                request.dataIdentity,
                request.requestId,
                requestJson,
                JSON.stringify(receipt),
                request.changedAt,
              ],
            );
            return receipt;
          })
          .immediate(),
      catch: failed,
    });

  readonly stopActivity = (request: {
    readonly dataIdentity: string;
    readonly requestId: string;
    readonly projectId: string;
    readonly workflowName: string;
    readonly changedAt: string;
  }): Effect.Effect<WorkflowActivityReceipt, ProjectStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const requestJson = JSON.stringify([request.projectId, request.workflowName, "stop"]);
            const prior = this.#database
              .query<
                { readonly request_json: string; readonly receipt_json: string },
                [string, string]
              >(
                "SELECT request_json, receipt_json FROM workflow_activity_receipts WHERE data_identity = ? AND request_id = ?",
              )
              .get(request.dataIdentity, request.requestId);
            if (prior !== null) {
              if (prior.request_json !== requestJson) {
                throw new ProjectStoreError({
                  code: "REQUEST_ID_CONFLICT",
                  message: "This request ID already names different request content.",
                  status: 409,
                  retry: "lookupOriginal",
                  remedy: "Look up the original request.",
                });
              }
              return JSON.parse(prior.receipt_json) as WorkflowActivityReceipt;
            }
            const workflow = this.#workflowRow(request.projectId, request.workflowName);
            const trigger = workflow.trigger_state !== "not-declared";
            this.#database.run(
              "DELETE FROM trigger_pollers WHERE project_id = ? AND workflow_name = ?",
              [request.projectId, request.workflowName],
            );
            this.#database.run(
              `UPDATE project_workflows SET activity = 'inactive',
                 trigger_state = CASE WHEN trigger_state = 'not-declared' THEN 'not-declared' ELSE 'not-observed' END,
                 trigger_observed_at = ?, trigger_detail = CASE WHEN trigger_state = 'not-declared' THEN NULL ELSE 'stopped' END
               WHERE project_id = ? AND workflow_name = ?`,
              [request.changedAt, request.projectId, request.workflowName],
            );
            const receipt: WorkflowActivityReceipt = {
              projectId: request.projectId,
              workflowName: request.workflowName,
              activity: "inactive",
              trigger,
              pollerStarted: false,
              changedAt: request.changedAt,
            };
            this.#database.run(
              "INSERT INTO workflow_activity_receipts (data_identity, request_id, request_json, receipt_json, committed_at) VALUES (?, ?, ?, ?, ?)",
              [
                request.dataIdentity,
                request.requestId,
                requestJson,
                JSON.stringify(receipt),
                request.changedAt,
              ],
            );
            return receipt;
          })
          .immediate(),
      catch: failed,
    });

  readonly triggerPollers: Effect.Effect<ReadonlyArray<TriggerPoller>, ProjectStoreError> =
    Effect.try({
      try: () =>
        this.#database
          .query<
            {
              readonly projectId: string;
              readonly workflowName: string;
              readonly pollerId: string;
              readonly startedAt: string;
            },
            []
          >(
            "SELECT project_id AS projectId, workflow_name AS workflowName, poller_id AS pollerId, started_at AS startedAt FROM trigger_pollers ORDER BY started_at",
          )
          .all(),
      catch: failed,
    });

  readonly observeTrigger = (request: {
    readonly projectId: string;
    readonly workflowName: string;
    readonly state: "polling" | "delayed" | "failed";
    readonly detail: string;
    readonly observedAt: string;
  }): Effect.Effect<void, ProjectStoreError> =>
    Effect.try({
      try: () => {
        this.#workflowRow(request.projectId, request.workflowName);
        this.#database.run(
          `UPDATE project_workflows
              SET trigger_state = ?, trigger_detail = ?, trigger_observed_at = ?
            WHERE project_id = ? AND workflow_name = ?`,
          [
            request.state,
            request.detail,
            request.observedAt,
            request.projectId,
            request.workflowName,
          ],
        );
      },
      catch: failed,
    });

  readonly admissibleRevision = (
    projectId: string,
    workflowName: string,
  ): Effect.Effect<string, ProjectStoreError> =>
    Effect.try({
      try: () => {
        const row = this.#database
          .query<
            {
              readonly project_state: string;
              readonly factory_state: string;
              readonly refresh_state: string;
              readonly availability: string;
              readonly current_revision_id: string | null;
            },
            [string, string]
          >(
            `SELECT p.project_state, p.factory_state, p.refresh_state,
                    w.availability, w.current_revision_id
               FROM projects p
               JOIN project_workflows w ON w.project_id = p.project_id
              WHERE p.project_id = ? AND w.workflow_name = ?`,
          )
          .get(projectId, workflowName);
        if (row === null) {
          throw new ProjectStoreError({
            code: "WORKFLOW_NOT_FOUND",
            message: "The selected Project Workflow does not exist.",
            status: 404,
            retry: "never",
            remedy: "Select a Workflow from the authoritative Workflow snapshot.",
          });
        }
        if (row.refresh_state === "pending" || row.refresh_state === "refreshing") {
          throw new ProjectStoreError({
            code: "REFRESH_PENDING",
            message: "Run admission waits while Factory Refresh is pending.",
            status: 409,
            retry: "safe",
            remedy: "Wait for the current Factory Refresh. Kojo will not use older source.",
          });
        }
        if (row.refresh_state === "failed") {
          throw new ProjectStoreError({
            code: "REFRESH_FAILED",
            message: "Run admission is held because Factory Refresh failed.",
            status: 409,
            retry: "safe",
            remedy: "Repair the reported refresh fault and refresh the Factory.",
          });
        }
        if (
          row.project_state !== "available" ||
          row.factory_state !== "available" ||
          row.availability !== "available" ||
          row.current_revision_id === null
        ) {
          throw new ProjectStoreError({
            code: "WORKFLOW_UNAVAILABLE",
            message: "The selected Project Workflow is not available for admission.",
            status: 409,
            retry: "never",
            remedy: "Repair the Project, Factory, or Workflow fault shown in its snapshot.",
          });
        }
        return row.current_revision_id;
      },
      catch: failed,
    });

  readonly executionRevision = (
    projectId: string,
    workflowName: string,
  ): Effect.Effect<ExecutionRevision, ProjectStoreError> =>
    this.admissibleRevision(projectId, workflowName).pipe(
      Effect.flatMap((revisionId) =>
        Effect.try({
          try: () => {
            const row = this.#database
              .query<
                {
                  readonly location: string;
                  readonly package_graph_id: string;
                  readonly published_path: string;
                  readonly manifest_json: string;
                },
                [string, string]
              >(
                `SELECT p.location, r.package_graph_id, r.published_path, r.manifest_json
                   FROM projects p
                   JOIN workflow_revisions r ON r.revision_id = ?
                  WHERE p.project_id = ?`,
              )
              .get(revisionId, projectId);
            if (row === null) throw new Error("the pinned Workflow Revision is missing");
            const manifest = JSON.parse(row.manifest_json) as { readonly entrySource?: unknown };
            if (typeof manifest.entrySource !== "string") {
              throw new Error("the pinned Workflow Revision manifest has no entry source");
            }
            return {
              projectId,
              location: row.location,
              workflowName,
              revisionId,
              packageGraphId: row.package_graph_id,
              publishedPath: row.published_path,
              entrySource: manifest.entrySource,
            };
          },
          catch: failed,
        }),
      ),
    );

  readonly retainedExecutionRevision = (
    projectId: string,
    workflowName: string,
    revisionId: string,
    packageGraphId: string,
  ): Effect.Effect<ExecutionRevision, ProjectStoreError> =>
    Effect.try({
      try: () => {
        const row = this.#database
          .query<
            {
              readonly location: string;
              readonly package_graph_id: string;
              readonly published_path: string;
              readonly manifest_json: string;
            },
            [string, string, string, string]
          >(
            `SELECT p.location, r.package_graph_id, r.published_path, r.manifest_json
               FROM projects p
               JOIN workflow_revision_registrations g ON g.project_id = p.project_id
               JOIN workflow_revisions r ON r.revision_id = g.revision_id
              WHERE p.project_id = ? AND g.workflow_name = ?
                AND g.revision_id = ? AND g.package_graph_id = ?
                AND r.package_graph_id = g.package_graph_id`,
          )
          .get(projectId, workflowName, revisionId, packageGraphId);
        if (row === null) throw new Error("the pinned Workflow Revision is missing");
        const manifest = JSON.parse(row.manifest_json) as { readonly entrySource?: unknown };
        if (typeof manifest.entrySource !== "string") {
          throw new Error("the pinned Workflow Revision manifest has no entry source");
        }
        return {
          projectId,
          location: row.location,
          workflowName,
          revisionId,
          packageGraphId: row.package_graph_id,
          publishedPath: row.published_path,
          entrySource: manifest.entrySource,
        };
      },
      catch: failed,
    });

  readonly settleManualActivity = (
    projectId: string,
    workflowName: string,
  ): Effect.Effect<void, ProjectStoreError> =>
    Effect.try({
      try: () => {
        const workflow = this.#workflowRow(projectId, workflowName);
        if (workflow.trigger_state !== "not-declared") return;
        const current =
          this.#database
            .query<{ readonly count: number }, [string, string]>(
              `SELECT COUNT(*) AS count FROM workflow_runs
                WHERE project_id = ? AND workflow_name = ?
                  AND state IN ('queued', 'executing', 'suspended')`,
            )
            .get(projectId, workflowName)?.count ?? 0;
        if (current === 0) {
          this.#database.run(
            "UPDATE project_workflows SET activity = 'inactive' WHERE project_id = ? AND workflow_name = ?",
            [projectId, workflowName],
          );
        }
      },
      catch: failed,
    });

  readonly receipt = (
    dataIdentity: string,
    requestId: string,
  ): Effect.Effect<OperationReceipt | undefined, ProjectStoreError> =>
    Effect.try({
      try: () => {
        const row = this.#database
          .query<{ readonly receipt_json: string }, [string, string]>(
            "SELECT receipt_json FROM client_receipts WHERE data_identity = ? AND request_id = ?",
          )
          .get(dataIdentity, requestId);
        return row === null ? undefined : (JSON.parse(row.receipt_json) as OperationReceipt);
      },
      catch: failed,
    });

  readonly snapshotVersion: Effect.Effect<number, ProjectStoreError> = Effect.try({
    try: () => {
      const row = this.#database
        .query<{ readonly value: string }, []>(
          "SELECT value FROM daemon_metadata WHERE name = 'project_snapshot_version'",
        )
        .get();
      return Number(row?.value ?? "0");
    },
    catch: failed,
  });

  readonly layer = Layer.succeed(ProjectRepository, {
    register: this.register,
    projects: this.projects,
    receipt: this.receipt,
    snapshotVersion: this.snapshotVersion,
  });

  #workflowRow(
    projectId: string,
    workflowName: string,
  ): Pick<WorkflowRow, "availability" | "current_revision_id" | "trigger_state"> {
    const row = this.#database
      .query<
        Pick<WorkflowRow, "availability" | "current_revision_id" | "trigger_state">,
        [string, string]
      >(
        "SELECT availability, current_revision_id, trigger_state FROM project_workflows WHERE project_id = ? AND workflow_name = ?",
      )
      .get(projectId, workflowName);
    if (row === null) {
      throw new ProjectStoreError({
        code: "WORKFLOW_NOT_FOUND",
        message: "The selected Project Workflow does not exist.",
        status: 404,
        retry: "never",
        remedy: "Select a Workflow from the authoritative Workflow snapshot.",
      });
    }
    return row;
  }
}
