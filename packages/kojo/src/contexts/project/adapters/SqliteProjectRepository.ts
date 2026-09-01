import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { ProjectDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { Effect, Layer } from "effect";
import type { RegisteredProject, RegisterProjectRequest } from "../models/Project.ts";
import { ProjectStoreError } from "../models/ProjectStoreError.ts";
import { ProjectRepository } from "../ports/ProjectRepository.ts";

interface ProjectRow {
  readonly project_id: string;
  readonly location: string;
  readonly project_state: "available" | "unavailable" | "archived";
  readonly factory_state: "missing" | "invalid" | "available";
  readonly registered_at: string;
  readonly refreshed_at: string;
  readonly fault: string | null;
  readonly remedy: string | null;
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
  registeredAt: row.registered_at,
  refreshedAt: row.refreshed_at,
  ...(row.fault === null ? {} : { fault: row.fault }),
  ...(row.remedy === null ? {} : { remedy: row.remedy }),
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
        registered_at TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        fault TEXT,
        remedy TEXT
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
              `SELECT project_id, location, project_state, factory_state, registered_at,
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
                 refreshed_at, fault, remedy
               ) VALUES (?, ?, 'available', ?, ?, ?, ?, ?)`,
              [
                projectId,
                request.location,
                request.factory.state,
                request.observedAt,
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
                `SELECT project_id, location, project_state, factory_state, registered_at,
                        refreshed_at, fault, remedy FROM projects WHERE project_id = ?`,
              )
              .get(projectId);
          }
          if (row === null) throw new Error("the committed Project could not be read");
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
          `SELECT project_id, location, project_state, factory_state, registered_at,
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
