import type { Database } from "bun:sqlite";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect, Layer } from "effect";
import type { DaemonRun } from "../../workflow/models/DaemonRun.ts";
import { RunStoreError } from "../../workflow/models/RunStoreError.ts";
import {
  DEFAULT_DAEMON_NEW_START_QUEUE,
  DEFAULT_PROJECT_NEW_START_QUEUE,
} from "../../workflow/models/SchedulingDefaults.ts";
import { runIdOf } from "../../workflow/services/runIdentity.ts";
import type {
  TriggerAdmission,
  TriggerDeliveryObservation,
  TriggerDeliveryRequest,
} from "../models/TriggerDelivery.ts";
import { TriggerRepository } from "../ports/TriggerRepository.ts";

interface RunRow {
  readonly run_id: string;
  readonly project_id: string;
  readonly workflow_name: string;
  readonly idempotency_key: string;
  readonly payload_json: string;
  readonly revision_id: string;
  readonly package_graph_id: string;
  readonly state: DaemonRun["state"];
  readonly admission_sequence: number;
  readonly admitted_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

const runOf = (row: RunRow): DaemonRun => ({
  runId: row.run_id,
  projectId: row.project_id,
  workflowName: row.workflow_name,
  idempotencyKey: row.idempotency_key,
  payload: JSON.parse(row.payload_json) as JsonValue,
  revisionId: row.revision_id,
  packageGraphId: row.package_graph_id,
  state: row.state,
  ...(row.state === "queued" ? { queueKind: "new", queueReason: "runner-starting" } : {}),
  admissionSequence: row.admission_sequence,
  admittedAt: row.admitted_at,
  ...(row.started_at === null ? {} : { startedAt: row.started_at }),
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
});

const failed = (cause: unknown): RunStoreError =>
  cause instanceof RunStoreError
    ? cause
    : new RunStoreError({
        code: "STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

/** Shared-database adapter that commits Trigger admission and acknowledgement evidence together. */
export class SqliteTriggerRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run(`
      CREATE TABLE IF NOT EXISTS trigger_deliveries (
        project_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('acknowledged', 'rejected')),
        run_id TEXT,
        reason TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, workflow_name, source, event_id),
        FOREIGN KEY (project_id, workflow_name) REFERENCES project_workflows(project_id, workflow_name),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
  }

  readonly admit = (
    request: TriggerDeliveryRequest,
  ): Effect.Effect<TriggerAdmission, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const prior = this.#database
              .query<
                { readonly state: string; readonly run_id: string | null },
                [string, string, string, string]
              >(
                `SELECT state, run_id FROM trigger_deliveries
                  WHERE project_id = ? AND workflow_name = ? AND source = ? AND event_id = ?`,
              )
              .get(request.projectId, request.workflowName, request.source, request.eventId);
            if (prior !== null) {
              if (prior.state !== "acknowledged" || prior.run_id === null) {
                throw new RunStoreError({
                  code: "RUN_NOT_ELIGIBLE",
                  message: "the Trigger event was rejected and cannot become an admitted Run",
                });
              }
              return {
                run: runOf(this.#run(prior.run_id)),
                duplicate: true,
                acknowledgement: "durable" as const,
              };
            }
            const workflow = this.#database
              .query<
                { readonly activity: string; readonly trigger_state: string },
                [string, string]
              >(
                "SELECT activity, trigger_state FROM project_workflows WHERE project_id = ? AND workflow_name = ?",
              )
              .get(request.projectId, request.workflowName);
            if (
              workflow === null ||
              workflow.activity !== "active" ||
              workflow.trigger_state === "not-declared"
            ) {
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "the Workflow is not active for Trigger admission",
              });
            }
            const runId = runIdOf(request.projectId, request.workflowName, request.idempotencyKey);
            const existing = this.#database
              .query<RunRow, [string]>("SELECT * FROM workflow_runs WHERE run_id = ?")
              .get(runId);
            if (
              existing !== null &&
              (existing.project_id !== request.projectId ||
                existing.workflow_name !== request.workflowName ||
                existing.idempotency_key !== request.idempotencyKey)
            ) {
              throw new RunStoreError({
                code: "DEDUP_COLLISION",
                message: "the Run ID is bound to a different deduplication tuple",
              });
            }
            if (existing === null) {
              const capacity = this.#database
                .query<{ readonly global_count: number; readonly project_count: number }, [string]>(
                  `SELECT
                    (SELECT COUNT(*) FROM workflow_queue WHERE queue_kind = 'new') AS global_count,
                    (SELECT COUNT(*) FROM workflow_queue WHERE queue_kind = 'new' AND project_id = ?) AS project_count`,
                )
                .get(request.projectId);
              if (
                (capacity?.global_count ?? 0) >= DEFAULT_DAEMON_NEW_START_QUEUE ||
                (capacity?.project_count ?? 0) >= DEFAULT_PROJECT_NEW_START_QUEUE
              ) {
                throw new RunStoreError({
                  code: "QUEUE_FULL",
                  message:
                    "the Trigger event remains unacknowledged because the new-Run queue is full",
                });
              }
              const sequence = Number(
                this.#database
                  .query<{ readonly next: number }, []>(
                    "SELECT COALESCE(MAX(admission_sequence), 0) + 1 AS next FROM workflow_runs",
                  )
                  .get()?.next ?? 1,
              );
              this.#database.run(
                `INSERT INTO workflow_runs (
                   run_id, project_id, workflow_name, idempotency_key, payload_json,
                   revision_id, package_graph_id, state, admission_sequence, admitted_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
                [
                  runId,
                  request.projectId,
                  request.workflowName,
                  request.idempotencyKey,
                  JSON.stringify(request.payload),
                  request.revisionId,
                  request.packageGraphId,
                  sequence,
                  request.deliveredAt,
                ],
              );
              this.#database.run(
                "INSERT INTO workflow_queue (run_id, project_id, admission_sequence, queued_at, queue_kind, queue_reason) VALUES (?, ?, ?, ?, 'new', 'runner-starting')",
                [runId, request.projectId, sequence, request.deliveredAt],
              );
            }
            this.#database.run(
              `INSERT INTO trigger_deliveries (
                 project_id, workflow_name, source, event_id, state, run_id, observed_at
               ) VALUES (?, ?, ?, ?, 'acknowledged', ?, ?)`,
              [
                request.projectId,
                request.workflowName,
                request.source,
                request.eventId,
                runId,
                request.deliveredAt,
              ],
            );
            this.#database.run(
              `UPDATE project_workflows SET trigger_state = 'polling',
                 trigger_observed_at = ?, trigger_detail = 'event acknowledged after durable admission'
               WHERE project_id = ? AND workflow_name = ?`,
              [request.deliveredAt, request.projectId, request.workflowName],
            );
            return {
              run: runOf(existing ?? this.#run(runId)),
              duplicate: existing !== null,
              acknowledgement: "durable" as const,
            };
          })
          .immediate(),
      catch: failed,
    });

  readonly reject = (
    request: Omit<TriggerDeliveryRequest, "idempotencyKey" | "payload">,
    reason: string,
  ): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () => {
        this.#database.run(
          `INSERT INTO trigger_deliveries (
             project_id, workflow_name, source, event_id, state, reason, observed_at
           ) VALUES (?, ?, ?, ?, 'rejected', ?, ?)
           ON CONFLICT(project_id, workflow_name, source, event_id) DO NOTHING`,
          [
            request.projectId,
            request.workflowName,
            request.source,
            request.eventId,
            reason,
            request.deliveredAt,
          ],
        );
      },
      catch: failed,
    });

  readonly deliveries: Effect.Effect<ReadonlyArray<TriggerDeliveryObservation>, RunStoreError> =
    Effect.try({
      try: () =>
        this.#database
          .query<
            {
              readonly projectId: string;
              readonly workflowName: string;
              readonly source: string;
              readonly eventId: string;
              readonly state: "acknowledged" | "rejected";
              readonly runId: string | null;
              readonly reason: string | null;
              readonly observedAt: string;
            },
            []
          >(
            `SELECT project_id AS projectId, workflow_name AS workflowName, source,
                    event_id AS eventId, state, run_id AS runId, reason,
                    observed_at AS observedAt
               FROM trigger_deliveries ORDER BY observed_at, event_id`,
          )
          .all()
          .map((row) => ({
            projectId: row.projectId,
            workflowName: row.workflowName,
            source: row.source,
            eventId: row.eventId,
            state: row.state,
            ...(row.runId === null ? {} : { runId: row.runId }),
            ...(row.reason === null ? {} : { reason: row.reason }),
            observedAt: row.observedAt,
          })),
      catch: failed,
    });

  readonly layer = Layer.succeed(TriggerRepository, this);

  #run(runId: string): RunRow {
    const row = this.#database
      .query<RunRow, [string]>("SELECT * FROM workflow_runs WHERE run_id = ?")
      .get(runId);
    if (row === null) {
      throw new RunStoreError({ code: "RUN_NOT_FOUND", message: `Run ${runId} was not found` });
    }
    return row;
  }
}
