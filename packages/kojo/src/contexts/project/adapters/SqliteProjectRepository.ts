import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { ProjectDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type { WorkflowDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { Effect, Layer } from "effect";
import type { FactoryRefreshObservation } from "../../workflow/models/FactoryRefresh.ts";
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

const documentOf = (row: ProjectRow): ProjectDocument => ({
  projectId: row.project_id,
  label: basename(row.location),
  location: row.location,
  projectState: row.project_state,
  factoryState: row.factory_state,
  refreshState: row.refresh_state,
  registeredAt: row.registered_at,
  refreshedAt: row.refreshed_at,
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
  ...(row.candidate_revision_id === null ? {} : { candidateRevisionId: row.candidate_revision_id }),
  trigger: {
    state: row.trigger_state,
    ...(row.trigger_observed_at === null ? {} : { observedAt: row.trigger_observed_at }),
    ...(row.trigger_detail === null ? {} : { detail: row.trigger_detail }),
  },
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
    const projectColumns = database
      .query<{ readonly name: string }, []>("PRAGMA table_info(projects)")
      .all();
    if (!projectColumns.some((column) => column.name === "refresh_state")) {
      database.run("ALTER TABLE projects ADD COLUMN refresh_state TEXT NOT NULL DEFAULT 'current'");
    }
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
         ) VALUES (?, ?, 'inactive', ?, ?, ?, ?, ?, NULL, 'not-declared', ?)
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
          observedAt,
        ],
      );
    }
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
              `SELECT project_id, location, project_state, factory_state, refresh_state, registered_at,
                      refreshed_at, fault, remedy
                 FROM projects WHERE location = ? AND project_state != 'archived'`,
            )
            .get(request.location);
          const created = row === null;
          if (row === null) {
            const projectId = crypto.randomUUID();
            this.#database.run(
              `INSERT INTO projects (
                 project_id, location, project_state, factory_state, registered_at,
                 refresh_state, refreshed_at, fault, remedy
               ) VALUES (?, ?, 'available', ?, ?, ?, ?, ?, ?)`,
              [
                projectId,
                request.location,
                request.factory.state,
                request.observedAt,
                request.factory.refreshState ?? "current",
                request.observedAt,
                request.factory.fault ?? null,
                request.factory.remedy ?? null,
              ],
            );
            this.#database.run(
              "UPDATE daemon_metadata SET value = CAST(value AS INTEGER) + 1 WHERE name = 'project_snapshot_version'",
            );
            row = this.#database
              .query<ProjectRow, [string]>(
                `SELECT project_id, location, project_state, factory_state, refresh_state, registered_at,
                        refreshed_at, fault, remedy FROM projects WHERE project_id = ?`,
              )
              .get(projectId);
          }
          if (row === null) throw new Error("the committed Project could not be read");
          if (created) {
            this.#applyFactory(row.project_id, request.factory, request.observedAt);
            row = this.#database
              .query<ProjectRow, [string]>(
                `SELECT project_id, location, project_state, factory_state, refresh_state, registered_at,
                        refreshed_at, fault, remedy FROM projects WHERE project_id = ?`,
              )
              .get(row.project_id);
          }
          if (row === null) throw new Error("the refreshed Project could not be read");
          const project = documentOf(row);
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

  readonly projects: Effect.Effect<ReadonlyArray<ProjectDocument>, ProjectStoreError> = Effect.try({
    try: () => {
      const rows = this.#database
        .query<ProjectRow, []>(
          `SELECT project_id, location, project_state, factory_state, refresh_state, registered_at,
                  refreshed_at, fault, remedy FROM projects ORDER BY registered_at, project_id`,
        )
        .all();
      const documents = rows.map(documentOf);
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
                  p.location AS label, p.project_state, p.factory_state, p.refresh_state
             FROM project_workflows w
             JOIN projects p ON p.project_id = w.project_id
            ORDER BY p.registered_at, w.workflow_name`,
          )
          .all();
        const labelCounts = new Map<string, number>();
        for (const row of rows) {
          const label = basename(row.label);
          labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        }
        return rows.map((row) =>
          workflowDocumentOf({
            ...row,
            label:
              (labelCounts.get(basename(row.label)) ?? 0) > 1
                ? `${basename(row.label)} · ${row.project_id.slice(0, 8)}`
                : basename(row.label),
          }),
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
}
