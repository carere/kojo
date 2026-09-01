import type { Database } from "bun:sqlite";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import type { DaemonRun, PhaseResult, RunAuthority } from "../models/DaemonRun.ts";
import { RunStoreError } from "../models/RunStoreError.ts";
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
  state: row.state,
  admissionSequence: row.admission_sequence,
  admittedAt: row.admitted_at,
  ...(row.started_at === null ? {} : { startedAt: row.started_at }),
  ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
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
        state TEXT NOT NULL CHECK(state IN ('queued', 'executing', 'succeeded', 'failed')),
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
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
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
                "INSERT INTO workflow_queue (run_id, project_id, admission_sequence, queued_at) VALUES (?, ?, ?, ?)",
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
            const globalSlots =
              this.#database
                .query<{ readonly count: number }, []>(
                  "SELECT COUNT(*) AS count FROM workflow_slots",
                )
                .get()?.count ?? 0;
            if (globalSlots >= 4) {
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

  readonly read = (runId: string): Effect.Effect<DaemonRun | undefined, RunStoreError> =>
    Effect.try({
      try: () => {
        const row = this.#database
          .query<RunRow, [string]>("SELECT * FROM workflow_runs WHERE run_id = ?")
          .get(runId);
        return row === null ? undefined : runOf(row);
      },
      catch: failure,
    });

  readonly list: Effect.Effect<ReadonlyArray<DaemonRun>, RunStoreError> = Effect.try({
    try: () =>
      this.#database
        .query<RunRow, []>("SELECT * FROM workflow_runs ORDER BY admission_sequence DESC")
        .all()
        .map(runOf),
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
      .query<RunRow, [string]>("SELECT * FROM workflow_runs WHERE run_id = ?")
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
}
