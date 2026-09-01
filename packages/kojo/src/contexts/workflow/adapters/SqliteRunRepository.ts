import type { Database } from "bun:sqlite";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import type {
  ClaimedRun,
  DaemonRun,
  PhaseResult,
  RunAuthority,
  RunExecutionFault,
} from "../models/DaemonRun.ts";
import { RunStoreError } from "../models/RunStoreError.ts";
import {
  CONTINUATION_BURST,
  DEFAULT_DAEMON_EXECUTING_RUNS,
  DEFAULT_DAEMON_NEW_START_QUEUE,
  DEFAULT_PROJECT_NEW_START_QUEUE,
} from "../models/SchedulingDefaults.ts";
import type { Admission, AdmitRunRequest } from "../ports/RunRepository.ts";
import { runIdOf } from "../services/runIdentity.ts";

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
  readonly queue_kind?: "new" | "continuation" | null;
  readonly queue_reason?:
    | "execution-capacity"
    | "project-capacity"
    | "runner-starting"
    | "package-switch"
    | "pinned-content"
    | null;
  readonly hold_code?: RunExecutionFault["code"] | null;
  readonly hold_detail?: string | null;
  readonly hold_remedy?: string | null;
}

interface ClaimRow {
  readonly runner_instance_id: string;
  readonly generation: number;
  readonly revision_id: string;
}

interface PhaseRow {
  readonly phase_path: string;
  readonly attempt: number;
  readonly kind: PhaseResult["kind"];
  readonly outcome: PhaseResult["outcome"];
  readonly description: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly encoded_result: string;
}

const failure = (cause: unknown): RunStoreError =>
  cause instanceof RunStoreError
    ? cause
    : new RunStoreError({
        code: "STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const runOf = (row: RunRow): DaemonRun => ({
  runId: row.run_id,
  projectId: row.project_id,
  workflowName: row.workflow_name,
  idempotencyKey: row.idempotency_key,
  payload: JSON.parse(row.payload_json) as JsonValue,
  revisionId: row.revision_id,
  packageGraphId: row.package_graph_id,
  state: row.hold_code === undefined || row.hold_code === null ? row.state : "held",
  admissionSequence: row.admission_sequence,
  admittedAt: row.admitted_at,
  ...(row.started_at === null ? {} : { startedAt: row.started_at }),
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  ...(row.queue_kind == null ? {} : { queueKind: row.queue_kind }),
  ...(row.hold_code === undefined || row.hold_code === null
    ? row.queue_reason == null
      ? {}
      : { queueReason: row.queue_reason }
    : {
        queueReason: "pinned-content" as const,
        executionFault: {
          code: row.hold_code,
          detail: row.hold_detail ?? "the pinned Workflow Revision cannot execute",
          remedy: row.hold_remedy ?? "Restore the exact retained content.",
        },
      }),
});

const phaseOf = (row: PhaseRow): PhaseResult => ({
  phasePath: row.phase_path,
  attempt: row.attempt,
  kind: row.kind,
  outcome: row.outcome,
  description: row.description,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  encodedResult: JSON.parse(row.encoded_result) as JsonValue,
});

/** The sole-owner SQLite adapter for Run admission, Claims, slots, and replayed results. */
export class SqliteRunRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        package_graph_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'executing', 'suspended', 'succeeded', 'failed', 'cancelled')),
        admission_sequence INTEGER NOT NULL UNIQUE,
        admitted_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(project_id, workflow_name, idempotency_key),
        FOREIGN KEY (project_id, workflow_name) REFERENCES project_workflows(project_id, workflow_name),
        FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_queue (
        run_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        admission_sequence INTEGER NOT NULL,
        queued_at TEXT NOT NULL,
        queue_kind TEXT NOT NULL DEFAULT 'new' CHECK(queue_kind IN ('new', 'continuation')),
        queue_reason TEXT NOT NULL DEFAULT 'runner-starting' CHECK(queue_reason IN ('execution-capacity', 'project-capacity', 'runner-starting', 'package-switch')),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_scheduler_state (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        last_project_id TEXT
      ) STRICT
    `);
    database.run("INSERT OR IGNORE INTO workflow_scheduler_state (singleton) VALUES (1)");
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_reservations (
        run_id TEXT PRIMARY KEY NOT NULL,
        reservation_id TEXT NOT NULL UNIQUE,
        reserved_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_project_scheduler_state (
        project_id TEXT PRIMARY KEY NOT NULL,
        continuation_streak INTEGER NOT NULL DEFAULT 0
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_claims (
        run_id TEXT PRIMARY KEY NOT NULL,
        runner_instance_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        revision_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_slots (
        run_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL UNIQUE,
        runner_instance_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        allocated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_results (
        run_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        phase_path TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('actor', 'code', 'agent')),
        outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed', 'interrupted')),
        description TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        encoded_result TEXT NOT NULL,
        PRIMARY KEY (run_id, phase_path, attempt),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_admission_receipts (
        data_identity TEXT NOT NULL,
        request_id TEXT NOT NULL,
        canonical_request TEXT NOT NULL,
        run_id TEXT NOT NULL,
        duplicate INTEGER NOT NULL CHECK(duplicate IN (0, 1)),
        committed_at TEXT NOT NULL,
        PRIMARY KEY (data_identity, request_id),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_run_holds (
        run_id TEXT PRIMARY KEY NOT NULL,
        code TEXT NOT NULL CHECK(code IN (
          'RETAINED_CONTENT_MISSING',
          'RETAINED_CONTENT_CORRUPT',
          'RETAINED_HOST_INCOMPATIBLE',
          'RETAINED_PROTOCOL_INCOMPATIBLE'
        )),
        detail TEXT NOT NULL,
        remedy TEXT NOT NULL,
        held_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
  }

  readonly admit = (request: AdmitRunRequest): Effect.Effect<Admission, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const priorReceipt = this.#database
              .query<
                {
                  readonly canonical_request: string;
                  readonly run_id: string;
                  readonly duplicate: number;
                },
                [string, string]
              >(
                `SELECT canonical_request, run_id, duplicate
                 FROM workflow_admission_receipts
                WHERE data_identity = ? AND request_id = ?`,
              )
              .get(request.dataIdentity, request.requestId);
            if (priorReceipt !== null) {
              if (priorReceipt.canonical_request !== request.canonicalRequest) {
                throw new RunStoreError({
                  code: "REQUEST_CONFLICT",
                  message: "the request ID already names different canonical content",
                });
              }
              const row = this.#runRow(priorReceipt.run_id);
              return { run: runOf(row), duplicate: priorReceipt.duplicate === 1 };
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
                message: "the derived Run ID is already bound to a different deduplication tuple",
              });
            }

            let duplicate = existing !== null;
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
                  message: "the new-Run queue has reached its accepted capacity",
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
                  request.admittedAt,
                ],
              );
              this.#database.run(
                "INSERT INTO workflow_queue (run_id, project_id, admission_sequence, queued_at, queue_kind, queue_reason) VALUES (?, ?, ?, ?, 'new', 'runner-starting')",
                [runId, request.projectId, sequence, request.admittedAt],
              );
              duplicate = false;
            }
            this.#database.run(
              `INSERT INTO workflow_admission_receipts (
               data_identity, request_id, canonical_request, run_id, duplicate, committed_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                request.dataIdentity,
                request.requestId,
                request.canonicalRequest,
                runId,
                duplicate ? 1 : 0,
                request.admittedAt,
              ],
            );
            return { run: runOf(this.#runRow(runId)), duplicate };
          })
          .immediate(),
      catch: failure,
    });

  readonly claim = (
    runId: string,
    runnerInstanceId: string,
    claimedAt: string,
  ): Effect.Effect<RunAuthority, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const run = this.#runRow(runId);
            if (run.state !== "queued") {
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: `Run ${runId} is ${run.state}, not queued`,
              });
            }
            if (
              this.#database
                .query<{ readonly run_id: string }, [string]>(
                  "SELECT run_id FROM workflow_reservations WHERE run_id = ?",
                )
                .get(runId) !== null
            ) {
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "the Run is reserved for graph preparation",
              });
            }
            const globalSlots =
              this.#database
                .query<{ readonly count: number }, []>(
                  "SELECT COUNT(*) AS count FROM workflow_slots",
                )
                .get()?.count ?? 0;
            if (globalSlots >= DEFAULT_DAEMON_EXECUTING_RUNS) {
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "global execution capacity is full",
              });
            }
            const previous = this.#database
              .query<{ readonly generation: number }, [string]>(
                "SELECT generation FROM workflow_claims WHERE run_id = ?",
              )
              .get(runId);
            const generation = (previous?.generation ?? 0) + 1;
            this.#database.run(
              `INSERT INTO workflow_claims (run_id, runner_instance_id, generation, revision_id, claimed_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(run_id) DO UPDATE SET
               runner_instance_id = excluded.runner_instance_id,
               generation = excluded.generation,
               revision_id = excluded.revision_id,
               claimed_at = excluded.claimed_at`,
              [runId, runnerInstanceId, generation, run.revision_id, claimedAt],
            );
            this.#database.run(
              "INSERT INTO workflow_slots (run_id, project_id, runner_instance_id, generation, allocated_at) VALUES (?, ?, ?, ?, ?)",
              [runId, run.project_id, runnerInstanceId, generation, claimedAt],
            );
            this.#database.run("DELETE FROM workflow_queue WHERE run_id = ?", [runId]);
            this.#database.run(
              "UPDATE workflow_runs SET state = 'executing', started_at = COALESCE(started_at, ?) WHERE run_id = ?",
              [claimedAt, runId],
            );
            return { runId, runnerInstanceId, generation, revisionId: run.revision_id };
          })
          .immediate(),
      catch: failure,
    });

  readonly claimNext = (
    runnerInstanceId: string,
    claimedAt: string,
  ): Effect.Effect<ClaimedRun | undefined, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const globalSlots =
              this.#database
                .query<{ readonly count: number }, []>(
                  "SELECT COUNT(*) AS count FROM workflow_slots",
                )
                .get()?.count ?? 0;
            if (globalSlots >= DEFAULT_DAEMON_EXECUTING_RUNS) return undefined;
            const lastProject =
              this.#database
                .query<{ readonly last_project_id: string | null }, []>(
                  "SELECT last_project_id FROM workflow_scheduler_state WHERE singleton = 1",
                )
                .get()?.last_project_id ?? null;
            const projects = this.#database
              .query<{ readonly project_id: string }, []>(
                `SELECT DISTINCT q.project_id
                   FROM workflow_queue q
                  WHERE NOT EXISTS (
                    SELECT 1 FROM workflow_slots s WHERE s.project_id = q.project_id
                  )
                    AND NOT EXISTS (
                      SELECT 1 FROM workflow_reservations z
                      JOIN workflow_runs zr ON zr.run_id = z.run_id
                      WHERE zr.project_id = q.project_id
                    )
                  ORDER BY q.project_id`,
              )
              .all();
            const project =
              projects.find((candidate) =>
                lastProject === null ? true : candidate.project_id > lastProject,
              ) ?? projects[0];
            if (project === undefined) return undefined;
            const streak =
              this.#database
                .query<{ readonly continuation_streak: number }, [string]>(
                  "SELECT continuation_streak FROM workflow_project_scheduler_state WHERE project_id = ?",
                )
                .get(project.project_id)?.continuation_streak ?? 0;
            const select = (kind: "new" | "continuation"): RunRow | null =>
              this.#database
                .query<RunRow, [string, string]>(
                  `SELECT r.*, q.queue_kind, q.queue_reason
                     FROM workflow_queue q
                     JOIN workflow_runs r ON r.run_id = q.run_id
                    WHERE q.project_id = ? AND q.queue_kind = ?
                      AND NOT EXISTS (SELECT 1 FROM workflow_reservations z WHERE z.run_id = r.run_id)
                    ORDER BY q.admission_sequence LIMIT 1`,
                )
                .get(project.project_id, kind);
            const selected =
              streak >= CONTINUATION_BURST
                ? (select("new") ?? select("continuation"))
                : (select("continuation") ?? select("new"));
            if (selected === null) return undefined;
            const previous = this.#database
              .query<{ readonly generation: number }, [string]>(
                "SELECT generation FROM workflow_claims WHERE run_id = ?",
              )
              .get(selected.run_id);
            const generation = (previous?.generation ?? 0) + 1;
            this.#database.run(
              `INSERT INTO workflow_claims (run_id, runner_instance_id, generation, revision_id, claimed_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(run_id) DO UPDATE SET runner_instance_id = excluded.runner_instance_id,
                 generation = excluded.generation, revision_id = excluded.revision_id,
                 claimed_at = excluded.claimed_at`,
              [selected.run_id, runnerInstanceId, generation, selected.revision_id, claimedAt],
            );
            this.#database.run(
              "INSERT INTO workflow_slots (run_id, project_id, runner_instance_id, generation, allocated_at) VALUES (?, ?, ?, ?, ?)",
              [selected.run_id, selected.project_id, runnerInstanceId, generation, claimedAt],
            );
            this.#database.run("DELETE FROM workflow_queue WHERE run_id = ?", [selected.run_id]);
            this.#database.run(
              "UPDATE workflow_runs SET state = 'executing', started_at = COALESCE(started_at, ?) WHERE run_id = ?",
              [claimedAt, selected.run_id],
            );
            this.#database.run(
              "UPDATE workflow_scheduler_state SET last_project_id = ? WHERE singleton = 1",
              [selected.project_id],
            );
            const nextStreak = selected.queue_kind === "continuation" ? streak + 1 : 0;
            this.#database.run(
              `INSERT INTO workflow_project_scheduler_state (project_id, continuation_streak)
               VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET continuation_streak = excluded.continuation_streak`,
              [selected.project_id, nextStreak],
            );
            const authority = {
              runId: selected.run_id,
              runnerInstanceId,
              generation,
              revisionId: selected.revision_id,
            };
            const run = runOf({
              ...selected,
              state: "executing",
              queue_kind: null,
              queue_reason: null,
            });
            return { run, authority };
          })
          .immediate(),
      catch: failure,
    });

  readonly reserveNext = (
    reservationId: string,
    reservedAt: string,
  ): Effect.Effect<
    { readonly run: DaemonRun; readonly reservationId: string } | undefined,
    RunStoreError
  > =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const used =
              this.#database
                .query<{ readonly count: number }, []>(
                  "SELECT (SELECT COUNT(*) FROM workflow_slots) + (SELECT COUNT(*) FROM workflow_reservations) AS count",
                )
                .get()?.count ?? 0;
            if (used >= DEFAULT_DAEMON_EXECUTING_RUNS) return undefined;
            const lastProject =
              this.#database
                .query<{ readonly last_project_id: string | null }, []>(
                  "SELECT last_project_id FROM workflow_scheduler_state WHERE singleton = 1",
                )
                .get()?.last_project_id ?? null;
            const projects = this.#database
              .query<{ readonly project_id: string }, []>(
                `SELECT DISTINCT q.project_id
                   FROM workflow_queue q
                  WHERE NOT EXISTS (SELECT 1 FROM workflow_slots s WHERE s.project_id = q.project_id)
                    AND NOT EXISTS (
                      SELECT 1 FROM workflow_reservations z
                      JOIN workflow_runs zr ON zr.run_id = z.run_id
                      WHERE zr.project_id = q.project_id
                    )
                  ORDER BY q.project_id`,
              )
              .all();
            const project =
              projects.find((candidate) =>
                lastProject === null ? true : candidate.project_id > lastProject,
              ) ?? projects[0];
            if (project === undefined) return undefined;
            const streak =
              this.#database
                .query<{ readonly continuation_streak: number }, [string]>(
                  "SELECT continuation_streak FROM workflow_project_scheduler_state WHERE project_id = ?",
                )
                .get(project.project_id)?.continuation_streak ?? 0;
            const select = (kind: "new" | "continuation"): RunRow | null =>
              this.#database
                .query<RunRow, [string, string]>(
                  `SELECT r.*, q.queue_kind, q.queue_reason
                     FROM workflow_queue q JOIN workflow_runs r ON r.run_id = q.run_id
                    WHERE q.project_id = ? AND q.queue_kind = ?
                      AND NOT EXISTS (SELECT 1 FROM workflow_reservations z WHERE z.run_id = r.run_id)
                    ORDER BY q.admission_sequence LIMIT 1`,
                )
                .get(project.project_id, kind);
            const selected =
              streak >= CONTINUATION_BURST
                ? (select("new") ?? select("continuation"))
                : (select("continuation") ?? select("new"));
            if (selected === null) return undefined;
            this.#database.run(
              "INSERT INTO workflow_reservations (run_id, reservation_id, reserved_at) VALUES (?, ?, ?)",
              [selected.run_id, reservationId, reservedAt],
            );
            this.#database.run(
              "UPDATE workflow_scheduler_state SET last_project_id = ? WHERE singleton = 1",
              [selected.project_id],
            );
            this.#database.run(
              `INSERT INTO workflow_project_scheduler_state (project_id, continuation_streak)
               VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET continuation_streak = excluded.continuation_streak`,
              [selected.project_id, selected.queue_kind === "continuation" ? streak + 1 : 0],
            );
            return { run: this.#visibleQueueReason(runOf(selected)), reservationId };
          })
          .immediate(),
      catch: failure,
    });

  readonly claimReserved = (
    reservationId: string,
    runnerInstanceId: string,
    claimedAt: string,
  ): Effect.Effect<RunAuthority, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const run = this.#database
              .query<RunRow, [string]>(
                `SELECT r.*, q.queue_kind, q.queue_reason
                   FROM workflow_reservations z
                   JOIN workflow_runs r ON r.run_id = z.run_id
                   JOIN workflow_queue q ON q.run_id = r.run_id
                  WHERE z.reservation_id = ?`,
              )
              .get(reservationId);
            if (run === null || run.state !== "queued") {
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "the reservation is stale",
              });
            }
            const generation =
              (this.#database
                .query<{ readonly generation: number }, [string]>(
                  "SELECT generation FROM workflow_claims WHERE run_id = ?",
                )
                .get(run.run_id)?.generation ?? 0) + 1;
            this.#database.run(
              `INSERT INTO workflow_claims (run_id, runner_instance_id, generation, revision_id, claimed_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(run_id) DO UPDATE SET runner_instance_id = excluded.runner_instance_id,
                 generation = excluded.generation, revision_id = excluded.revision_id,
                 claimed_at = excluded.claimed_at`,
              [run.run_id, runnerInstanceId, generation, run.revision_id, claimedAt],
            );
            this.#database.run(
              "INSERT INTO workflow_slots (run_id, project_id, runner_instance_id, generation, allocated_at) VALUES (?, ?, ?, ?, ?)",
              [run.run_id, run.project_id, runnerInstanceId, generation, claimedAt],
            );
            this.#database.run("DELETE FROM workflow_queue WHERE run_id = ?", [run.run_id]);
            this.#database.run("DELETE FROM workflow_reservations WHERE run_id = ?", [run.run_id]);
            this.#database.run(
              "UPDATE workflow_runs SET state = 'executing', started_at = COALESCE(started_at, ?) WHERE run_id = ?",
              [claimedAt, run.run_id],
            );
            return { runId: run.run_id, runnerInstanceId, generation, revisionId: run.revision_id };
          })
          .immediate(),
      catch: failure,
    });

  readonly holdReserved = (
    reservationId: string,
    fault: NonNullable<DaemonRun["executionFault"]>,
    heldAt: string,
  ): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const row = this.#database
              .query<{ readonly run_id: string }, [string]>(
                "SELECT run_id FROM workflow_reservations WHERE reservation_id = ?",
              )
              .get(reservationId);
            if (row === null) {
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "the reservation is stale",
              });
            }
            this.#database.run(
              "INSERT INTO workflow_run_holds (run_id, code, detail, remedy, held_at) VALUES (?, ?, ?, ?, ?)",
              [row.run_id, fault.code, fault.detail, fault.remedy, heldAt],
            );
            this.#database.run("DELETE FROM workflow_queue WHERE run_id = ?", [row.run_id]);
            this.#database.run("DELETE FROM workflow_reservations WHERE run_id = ?", [row.run_id]);
          })
          .immediate(),
      catch: failure,
    });

  readonly suspend = (
    authority: RunAuthority,
    _suspendedAt: string,
  ): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            this.#database.run("UPDATE workflow_runs SET state = 'suspended' WHERE run_id = ?", [
              authority.runId,
            ]);
            this.#database.run("DELETE FROM workflow_slots WHERE run_id = ?", [authority.runId]);
            this.#database.run("DELETE FROM workflow_claims WHERE run_id = ?", [authority.runId]);
          })
          .immediate(),
      catch: failure,
    });

  readonly hold = (
    authority: RunAuthority,
    fault: NonNullable<DaemonRun["executionFault"]>,
    heldAt: string,
  ): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            this.#database.run(
              `INSERT INTO workflow_run_holds (run_id, code, detail, remedy, held_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(run_id) DO UPDATE SET
                 code = excluded.code,
                 detail = excluded.detail,
                 remedy = excluded.remedy,
                 held_at = excluded.held_at`,
              [authority.runId, fault.code, fault.detail, fault.remedy, heldAt],
            );
            this.#database.run("UPDATE workflow_runs SET state = 'queued' WHERE run_id = ?", [
              authority.runId,
            ]);
            this.#database.run("DELETE FROM workflow_queue WHERE run_id = ?", [authority.runId]);
            this.#database.run("DELETE FROM workflow_slots WHERE run_id = ?", [authority.runId]);
            this.#database.run("DELETE FROM workflow_claims WHERE run_id = ?", [authority.runId]);
          })
          .immediate(),
      catch: failure,
    });

  readonly continueRun = (runId: string, queuedAt: string): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const run = this.#runRow(runId);
            if (run.state !== "suspended") {
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "only a suspended Run can continue",
              });
            }
            this.#database.run("UPDATE workflow_runs SET state = 'queued' WHERE run_id = ?", [
              runId,
            ]);
            this.#database.run(
              "INSERT INTO workflow_queue (run_id, project_id, admission_sequence, queued_at, queue_kind, queue_reason) VALUES (?, ?, ?, ?, 'continuation', 'runner-starting')",
              [runId, run.project_id, run.admission_sequence, queuedAt],
            );
          })
          .immediate(),
      catch: failure,
    });

  readonly read = (runId: string): Effect.Effect<DaemonRun | undefined, RunStoreError> =>
    Effect.try({
      try: () => {
        const row = this.#database
          .query<RunRow, [string]>(
            `SELECT r.*, q.queue_kind, q.queue_reason,
                    h.code AS hold_code, h.detail AS hold_detail, h.remedy AS hold_remedy
               FROM workflow_runs r
               LEFT JOIN workflow_queue q ON q.run_id = r.run_id
               LEFT JOIN workflow_run_holds h ON h.run_id = r.run_id
              WHERE r.run_id = ?`,
          )
          .get(runId);
        return row === null ? undefined : this.#visibleQueueReason(runOf(row));
      },
      catch: failure,
    });

  readonly list: Effect.Effect<ReadonlyArray<DaemonRun>, RunStoreError> = Effect.try({
    try: () =>
      this.#database
        .query<RunRow, []>(
          `SELECT r.*, q.queue_kind, q.queue_reason,
                  h.code AS hold_code, h.detail AS hold_detail, h.remedy AS hold_remedy
             FROM workflow_runs r
             LEFT JOIN workflow_queue q ON q.run_id = r.run_id
             LEFT JOIN workflow_run_holds h ON h.run_id = r.run_id
            ORDER BY r.admission_sequence DESC`,
        )
        .all()
        .map(runOf)
        .map((run) => this.#visibleQueueReason(run)),
    catch: failure,
  });

  /**
   * Return Runs owned by the stopped Daemon to the queue before a replacement owner dispatches.
   *
   * The prior Claim stays as generation evidence. The next Claim replaces it with a higher
   * generation, so a message from the stopped Runner cannot regain authority.
   */
  readonly recoverInterruptedExecutions = (queuedAt: string): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#database.run("DELETE FROM workflow_reservations");
            this.#database.run(
              `INSERT INTO workflow_queue (run_id, project_id, admission_sequence, queued_at)
               SELECT run_id, project_id, admission_sequence, ?
                 FROM workflow_runs
                WHERE state = 'executing'
               ON CONFLICT(run_id) DO NOTHING`,
              [queuedAt],
            );
            this.#database.run(
              "DELETE FROM workflow_slots WHERE run_id IN (SELECT run_id FROM workflow_runs WHERE state = 'executing')",
            );
            this.#database.run(
              "UPDATE workflow_runs SET state = 'queued' WHERE state = 'executing'",
            );
          })
          .immediate(),
      catch: failure,
    });

  readonly readResult = (
    authority: RunAuthority,
    phasePath: string,
    attempt: number,
  ): Effect.Effect<JsonValue | undefined, RunStoreError> =>
    Effect.try({
      try: () => {
        this.#assertAuthority(authority);
        const row = this.#database
          .query<{ readonly encoded_result: string }, [string, string, number]>(
            "SELECT encoded_result FROM workflow_results WHERE run_id = ? AND phase_path = ? AND attempt = ?",
          )
          .get(authority.runId, phasePath, attempt);
        return row === null ? undefined : (JSON.parse(row.encoded_result) as JsonValue);
      },
      catch: failure,
    });

  readonly completePhase = (
    authority: RunAuthority,
    phase: PhaseResult,
  ): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            this.#database.run(
              `INSERT INTO workflow_results (
               run_id, revision_id, phase_path, attempt, kind, outcome, description,
               started_at, ended_at, encoded_result
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id, phase_path, attempt) DO NOTHING`,
              [
                authority.runId,
                authority.revisionId,
                phase.phasePath,
                phase.attempt,
                phase.kind,
                phase.outcome,
                phase.description,
                phase.startedAt,
                phase.endedAt,
                JSON.stringify(phase.encodedResult),
              ],
            );
          })
          .immediate(),
      catch: failure,
    });

  readonly completeRun = (
    authority: RunAuthority,
    state: "succeeded" | "failed",
    finishedAt: string,
  ): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            this.#database.run(
              "UPDATE workflow_runs SET state = ?, finished_at = ? WHERE run_id = ?",
              [state, finishedAt, authority.runId],
            );
            this.#database.run("DELETE FROM workflow_slots WHERE run_id = ?", [authority.runId]);
            this.#database.run("DELETE FROM workflow_claims WHERE run_id = ?", [authority.runId]);
          })
          .immediate(),
      catch: failure,
    });

  /** A continuation can fail before it acquires a Claim, for example during revision materialization. */
  readonly failQueuedRun = (
    runId: string,
    finishedAt: string,
  ): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#database.run(
              "UPDATE workflow_runs SET state = 'failed', finished_at = ? WHERE run_id = ? AND state = 'queued'",
              [finishedAt, runId],
            );
            this.#database.run("DELETE FROM workflow_queue WHERE run_id = ?", [runId]);
          })
          .immediate(),
      catch: failure,
    });

  readonly phases = (runId: string): Effect.Effect<ReadonlyArray<PhaseResult>, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .query<PhaseRow, [string]>(
            "SELECT phase_path, attempt, kind, outcome, description, started_at, ended_at, encoded_result FROM workflow_results WHERE run_id = ? ORDER BY started_at, phase_path, attempt",
          )
          .all(runId)
          .map(phaseOf),
      catch: failure,
    });

  #runRow(runId: string): RunRow {
    const row = this.#database
      .query<RunRow, [string]>(
        `SELECT r.*, q.queue_kind, q.queue_reason,
                h.code AS hold_code, h.detail AS hold_detail, h.remedy AS hold_remedy
           FROM workflow_runs r
           LEFT JOIN workflow_queue q ON q.run_id = r.run_id
           LEFT JOIN workflow_run_holds h ON h.run_id = r.run_id
          WHERE r.run_id = ?`,
      )
      .get(runId);
    if (row === null) {
      throw new RunStoreError({ code: "RUN_NOT_FOUND", message: `Run ${runId} was not found` });
    }
    return row;
  }

  #assertAuthority(authority: RunAuthority): void {
    const claim = this.#database
      .query<ClaimRow, [string]>(
        "SELECT runner_instance_id, generation, revision_id FROM workflow_claims WHERE run_id = ?",
      )
      .get(authority.runId);
    const slot = this.#database
      .query<{ readonly runner_instance_id: string; readonly generation: number }, [string]>(
        "SELECT runner_instance_id, generation FROM workflow_slots WHERE run_id = ?",
      )
      .get(authority.runId);
    if (
      claim === null ||
      slot === null ||
      claim.runner_instance_id !== authority.runnerInstanceId ||
      slot.runner_instance_id !== authority.runnerInstanceId ||
      claim.generation !== authority.generation ||
      slot.generation !== authority.generation ||
      claim.revision_id !== authority.revisionId
    ) {
      throw new RunStoreError({
        code: "STALE_AUTHORITY",
        message: "the Runner Claim or execution slot is stale",
      });
    }
  }

  #visibleQueueReason(run: DaemonRun): DaemonRun {
    if (run.state !== "queued") return run;
    const globalSlots =
      this.#database
        .query<{ readonly count: number }, []>("SELECT COUNT(*) AS count FROM workflow_slots")
        .get()?.count ?? 0;
    const projectSlot = this.#database
      .query<{ readonly package_graph_id: string }, [string]>(
        `SELECT r.package_graph_id
             FROM workflow_slots s
             JOIN workflow_runs r ON r.run_id = s.run_id
            WHERE s.project_id = ?`,
      )
      .get(run.projectId);
    return {
      ...run,
      queueReason:
        projectSlot !== null && projectSlot.package_graph_id !== run.packageGraphId
          ? "package-switch"
          : globalSlots >= DEFAULT_DAEMON_EXECUTING_RUNS
            ? "execution-capacity"
            : projectSlot !== null
              ? "project-capacity"
              : (run.queueReason ?? "runner-starting"),
    };
  }
}
