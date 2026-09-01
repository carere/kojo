import type { Database } from "bun:sqlite";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import type { PhaseResult, RunAuthority } from "../models/DaemonRun.ts";
import type {
  AuthorizeUncertainRetryRequest,
  ExternalActionDecision,
  ExternalActionEvidence,
  ExternalActionIntent,
  ExternalActionRecoveryPolicy,
  ExternalActionState,
} from "../models/ExternalAction.ts";
import { RunStoreError } from "../models/RunStoreError.ts";
import type { BeginExternalActionRequest } from "../ports/ExternalActionRepository.ts";

interface ActionRow {
  readonly action_id: string;
  readonly run_id: string;
  readonly revision_id: string;
  readonly phase_path: string;
  readonly attempt: number;
  readonly input_hash: string;
  readonly recovery_policy: ExternalActionRecoveryPolicy;
  readonly state: ExternalActionState;
  readonly uncertainty_revision: number;
  readonly intended_at: string;
  readonly updated_at: string;
  readonly evidence_kind:
    | "original-result"
    | "not-performed"
    | "safe-repetition"
    | "unresolved"
    | null;
  readonly evidence_detail: string | null;
  readonly evidence_observed_at: string | null;
  readonly evidence_result_json: string | null;
  readonly retry_reason: string | null;
  readonly retry_uncertainty_revision: number | null;
  readonly retry_authorized_at: string | null;
  readonly retry_consumed_at: string | null;
}

const failure = (cause: unknown): RunStoreError =>
  cause instanceof RunStoreError
    ? cause
    : new RunStoreError({
        code: "STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const actionOf = (row: ActionRow): ExternalActionIntent => ({
  actionId: row.action_id,
  runId: row.run_id,
  revisionId: row.revision_id,
  phasePath: row.phase_path,
  attempt: row.attempt,
  inputHash: row.input_hash,
  recoveryPolicy: row.recovery_policy,
  state: row.state,
  uncertaintyRevision: row.uncertainty_revision,
  intendedAt: row.intended_at,
  updatedAt: row.updated_at,
  ...(row.evidence_kind === null ||
  row.evidence_detail === null ||
  row.evidence_observed_at === null
    ? {}
    : {
        evidence: {
          kind: row.evidence_kind as NonNullable<ExternalActionIntent["evidence"]>["kind"],
          detail: row.evidence_detail,
          observedAt: row.evidence_observed_at,
          ...(row.evidence_result_json === null
            ? {}
            : { result: JSON.parse(row.evidence_result_json) as JsonValue }),
        },
      }),
  ...(row.retry_reason === null ||
  row.retry_uncertainty_revision === null ||
  row.retry_authorized_at === null
    ? {}
    : {
        retryAuthorization: {
          reason: row.retry_reason,
          possibleDuplicationAcknowledged: true as const,
          uncertaintyRevision: row.retry_uncertainty_revision,
          authorizedAt: row.retry_authorized_at,
          ...(row.retry_consumed_at === null ? {} : { consumedAt: row.retry_consumed_at }),
        },
      }),
});

/** Daemon-owned action intent and evidence. Trace is not consulted. */
export class SqliteExternalActionRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_external_actions (
        action_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        phase_path TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK(attempt >= 1),
        input_hash TEXT NOT NULL,
        recovery_policy TEXT NOT NULL CHECK(recovery_policy IN ('recover-result', 'prove-not-performed', 'safe-repetition', 'unresolved')),
        state TEXT NOT NULL CHECK(state IN ('intended', 'unresolved', 'retry-authorized', 'result-confirmed', 'not-performed', 'repetition-safe')),
        uncertainty_revision INTEGER NOT NULL DEFAULT 0 CHECK(uncertainty_revision >= 0),
        intended_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        evidence_kind TEXT CHECK(evidence_kind IN ('original-result', 'not-performed', 'safe-repetition', 'unresolved')),
        evidence_detail TEXT,
        evidence_observed_at TEXT,
        evidence_result_json TEXT,
        retry_reason TEXT,
        retry_uncertainty_revision INTEGER,
        retry_authorized_at TEXT,
        retry_consumed_at TEXT,
        UNIQUE(run_id, revision_id, phase_path, attempt),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_uncertain_retry_receipts (
        data_identity TEXT NOT NULL,
        request_id TEXT NOT NULL,
        canonical_request TEXT NOT NULL,
        action_id TEXT NOT NULL,
        uncertainty_revision INTEGER NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (data_identity, request_id),
        FOREIGN KEY (action_id) REFERENCES workflow_external_actions(action_id)
      ) STRICT
    `);
  }

  readonly #row = (actionId: string): ActionRow => {
    const row = this.#database
      .query<ActionRow, [string]>("SELECT * FROM workflow_external_actions WHERE action_id = ?")
      .get(actionId);
    if (row === null)
      throw new RunStoreError({
        code: "RUN_NOT_FOUND",
        message: `Action ${actionId} was not found`,
      });
    return row;
  };

  readonly #assertAuthority = (authority: RunAuthority): void => {
    const claim = this.#database
      .query<
        {
          readonly runner_instance_id: string;
          readonly generation: number;
          readonly revision_id: string;
        },
        [string]
      >("SELECT runner_instance_id, generation, revision_id FROM workflow_claims WHERE run_id = ?")
      .get(authority.runId);
    if (
      claim === null ||
      claim.runner_instance_id !== authority.runnerInstanceId ||
      claim.generation !== authority.generation ||
      claim.revision_id !== authority.revisionId
    ) {
      throw new RunStoreError({
        code: "STALE_AUTHORITY",
        message: "the Project Runner does not hold current action authority",
      });
    }
  };

  readonly #queueHeldRun = (runId: string, queuedAt: string): void => {
    const run = this.#database
      .query<
        {
          readonly project_id: string;
          readonly admission_sequence: number;
          readonly state: string;
        },
        [string]
      >("SELECT project_id, admission_sequence, state FROM workflow_runs WHERE run_id = ?")
      .get(runId);
    if (run === null || run.state !== "held") return;
    this.#database.run("UPDATE workflow_runs SET state = 'queued' WHERE run_id = ?", [runId]);
    this.#database.run(
      `INSERT INTO workflow_queue (run_id, project_id, admission_sequence, queued_at, queue_kind, queue_reason)
       VALUES (?, ?, ?, ?, 'continuation', 'runner-starting')
       ON CONFLICT(run_id) DO UPDATE SET queued_at = excluded.queued_at,
         queue_kind = 'continuation', queue_reason = 'runner-starting'`,
      [runId, run.project_id, run.admission_sequence, queuedAt],
    );
  };

  readonly begin = (
    request: BeginExternalActionRequest,
  ): Effect.Effect<ExternalActionDecision, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(request.authority);
            const prior = this.#database
              .query<ActionRow, [string]>(
                "SELECT * FROM workflow_external_actions WHERE action_id = ?",
              )
              .get(request.actionId);
            if (prior === null) {
              this.#database.run(
                `INSERT INTO workflow_external_actions (
                  action_id, run_id, revision_id, phase_path, attempt, input_hash,
                  recovery_policy, state, intended_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
                [
                  request.actionId,
                  request.authority.runId,
                  request.authority.revisionId,
                  request.phasePath,
                  request.attempt,
                  request.inputHash,
                  request.recoveryPolicy,
                  request.intendedAt,
                  request.intendedAt,
                ],
              );
              return { kind: "perform" as const, action: actionOf(this.#row(request.actionId)) };
            }
            if (
              prior.run_id !== request.authority.runId ||
              prior.revision_id !== request.authority.revisionId ||
              prior.phase_path !== request.phasePath ||
              prior.attempt !== request.attempt ||
              prior.input_hash !== request.inputHash ||
              prior.recovery_policy !== request.recoveryPolicy
            ) {
              throw new RunStoreError({
                code: "REQUEST_CONFLICT",
                message: "the action ID already names different immutable action content",
              });
            }
            if (prior.state === "result-confirmed" && prior.evidence_result_json !== null) {
              return {
                kind: "reuse-result" as const,
                action: actionOf(prior),
                result: JSON.parse(prior.evidence_result_json) as JsonValue,
              };
            }
            const evidencePermits =
              prior.state === "not-performed" || prior.state === "repetition-safe";
            const authorized = prior.state === "retry-authorized";
            if (evidencePermits || authorized) {
              this.#database.run(
                `UPDATE workflow_external_actions SET state = 'intended', updated_at = ?,
                   retry_consumed_at = CASE WHEN state = 'retry-authorized' THEN ? ELSE retry_consumed_at END
                 WHERE action_id = ?`,
                [request.intendedAt, request.intendedAt, request.actionId],
              );
              return { kind: "perform" as const, action: actionOf(this.#row(request.actionId)) };
            }
            if (prior.state === "intended") {
              this.#database.run(
                `UPDATE workflow_external_actions SET state = 'unresolved',
                   uncertainty_revision = uncertainty_revision + 1, updated_at = ?,
                   evidence_kind = 'unresolved',
                   evidence_detail = 'The prior action intent has no committed result. Missing output does not prove no action occurred.',
                   evidence_observed_at = ?, evidence_result_json = NULL
                 WHERE action_id = ?`,
                [request.intendedAt, request.intendedAt, request.actionId],
              );
              this.#database.run("DELETE FROM workflow_queue WHERE run_id = ?", [
                request.authority.runId,
              ]);
              this.#database.run("DELETE FROM workflow_slots WHERE run_id = ?", [
                request.authority.runId,
              ]);
              this.#database.run("DELETE FROM workflow_claims WHERE run_id = ?", [
                request.authority.runId,
              ]);
              this.#database.run("UPDATE workflow_runs SET state = 'held' WHERE run_id = ?", [
                request.authority.runId,
              ]);
            }
            return { kind: "hold" as const, action: actionOf(this.#row(request.actionId)) };
          })
          .immediate(),
      catch: failure,
    });

  readonly confirmResult = (
    authority: RunAuthority,
    actionId: string,
    phase: PhaseResult,
    detail: string,
    confirmedAt: string,
  ): Effect.Effect<ExternalActionIntent, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            const row = this.#row(actionId);
            if (row.run_id !== authority.runId || row.revision_id !== authority.revisionId)
              throw new RunStoreError({
                code: "STALE_AUTHORITY",
                message: "the result does not match the action authority",
              });
            const encodedResult = JSON.stringify(phase.encodedResult);
            if (row.state === "result-confirmed") {
              if (row.evidence_result_json !== encodedResult)
                throw new RunStoreError({
                  code: "REQUEST_CONFLICT",
                  message: "the action already has a different confirmed result",
                });
              return actionOf(row);
            }
            if (row.state !== "intended")
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: `Action ${actionId} is ${row.state}; it cannot accept a result`,
              });
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
                encodedResult,
              ],
            );
            const stored = this.#database
              .query<
                {
                  readonly revision_id: string;
                  readonly kind: string;
                  readonly outcome: string;
                  readonly description: string;
                  readonly started_at: string;
                  readonly ended_at: string;
                  readonly encoded_result: string;
                },
                [string, string, number]
              >(
                `SELECT revision_id, kind, outcome, description, started_at, ended_at, encoded_result
                 FROM workflow_results WHERE run_id = ? AND phase_path = ? AND attempt = ?`,
              )
              .get(authority.runId, phase.phasePath, phase.attempt);
            if (
              stored === null ||
              stored.revision_id !== authority.revisionId ||
              stored.kind !== phase.kind ||
              stored.outcome !== phase.outcome ||
              stored.description !== phase.description ||
              stored.started_at !== phase.startedAt ||
              stored.ended_at !== phase.endedAt ||
              stored.encoded_result !== encodedResult
            ) {
              throw new RunStoreError({
                code: "REQUEST_CONFLICT",
                message: "the Phase already has a different committed result",
              });
            }
            this.#database.run(
              `UPDATE workflow_external_actions SET state = 'result-confirmed', updated_at = ?,
                 evidence_kind = 'original-result', evidence_detail = ?, evidence_observed_at = ?,
                 evidence_result_json = ? WHERE action_id = ?`,
              [confirmedAt, detail, confirmedAt, encodedResult, actionId],
            );
            return actionOf(this.#row(actionId));
          })
          .immediate(),
      catch: failure,
    });

  readonly recordEvidence = (
    actionId: string,
    uncertaintyRevision: number,
    evidence: ExternalActionEvidence,
    observedAt: string,
  ): Effect.Effect<ExternalActionIntent, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const prior = this.#row(actionId);
            if (prior.state !== "unresolved" || prior.uncertainty_revision !== uncertaintyRevision)
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "the evidence does not match the current unresolved action revision",
              });
            const state: ExternalActionState =
              evidence.kind === "original-result"
                ? "result-confirmed"
                : evidence.kind === "not-performed"
                  ? "not-performed"
                  : evidence.kind === "safe-repetition"
                    ? "repetition-safe"
                    : "unresolved";
            this.#database.run(
              `UPDATE workflow_external_actions SET state = ?, updated_at = ?, evidence_kind = ?,
                 evidence_detail = ?, evidence_observed_at = ?, evidence_result_json = ?,
                 retry_reason = NULL, retry_uncertainty_revision = NULL,
                 retry_authorized_at = NULL, retry_consumed_at = NULL
               WHERE action_id = ?`,
              [
                state,
                observedAt,
                evidence.kind,
                evidence.detail,
                observedAt,
                evidence.kind === "original-result" ? JSON.stringify(evidence.result) : null,
                actionId,
              ],
            );
            if (state !== "unresolved") this.#queueHeldRun(prior.run_id, observedAt);
            return actionOf(this.#row(actionId));
          })
          .immediate(),
      catch: failure,
    });

  readonly holdOpen = (
    runId: string,
    detail: string,
    observedAt: string,
  ): Effect.Effect<ReadonlyArray<ExternalActionIntent>, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const open = this.#database
              .query<ActionRow, [string]>(
                "SELECT * FROM workflow_external_actions WHERE run_id = ? AND state = 'intended' ORDER BY intended_at",
              )
              .all(runId);
            for (const action of open) {
              const repetitionIsDeclaredSafe = action.recovery_policy === "safe-repetition";
              this.#database.run(
                `UPDATE workflow_external_actions SET state = ?,
                   uncertainty_revision = uncertainty_revision + ?, updated_at = ?,
                   evidence_kind = ?, evidence_detail = ?, evidence_observed_at = ?,
                   evidence_result_json = NULL, retry_reason = NULL,
                   retry_uncertainty_revision = NULL, retry_authorized_at = NULL,
                   retry_consumed_at = NULL WHERE action_id = ?`,
                [
                  repetitionIsDeclaredSafe ? "repetition-safe" : "unresolved",
                  repetitionIsDeclaredSafe ? 0 : 1,
                  observedAt,
                  repetitionIsDeclaredSafe ? "safe-repetition" : "unresolved",
                  repetitionIsDeclaredSafe
                    ? "The retained adapter declared repetition safe for this exact action input."
                    : detail,
                  observedAt,
                  action.action_id,
                ],
              );
            }
            if (open.length > 0) {
              this.#database.run("DELETE FROM workflow_queue WHERE run_id = ?", [runId]);
              this.#database.run("DELETE FROM workflow_reservations WHERE run_id = ?", [runId]);
              this.#database.run(
                `UPDATE workflow_runs SET state = 'held' WHERE run_id = ?
                   AND state NOT IN ('succeeded', 'failed', 'cancelled')
                   AND NOT EXISTS (SELECT 1 FROM workflow_cancellations WHERE run_id = ?)`,
                [runId, runId],
              );
            }
            return open.map((action) => actionOf(this.#row(action.action_id)));
          })
          .immediate(),
      catch: failure,
    });

  /** Release the old execution only after its process group and Project resources are safe. */
  readonly settleAfterRunnerTermination = (
    authority: RunAuthority,
    queuedAt: string,
  ): Effect.Effect<ReadonlyArray<ExternalActionIntent>, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            const actions = this.#database
              .query<ActionRow, [string]>(
                `SELECT * FROM workflow_external_actions WHERE run_id = ?
                 AND state IN ('unresolved', 'repetition-safe') ORDER BY intended_at`,
              )
              .all(authority.runId);
            if (actions.length === 0)
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "the Run has no external action awaiting Runner termination",
              });
            this.#database.run("DELETE FROM workflow_slots WHERE run_id = ?", [authority.runId]);
            this.#database.run("DELETE FROM workflow_claims WHERE run_id = ?", [authority.runId]);
            if (actions.every((action) => action.state === "repetition-safe")) {
              this.#queueHeldRun(authority.runId, queuedAt);
            }
            return actions.map(actionOf);
          })
          .immediate(),
      catch: failure,
    });

  readonly authorizeRetry = (
    request: AuthorizeUncertainRetryRequest,
  ): Effect.Effect<ExternalActionIntent, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            if (request.reason.trim() === "" || request.possibleDuplicationAcknowledged !== true)
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message:
                  "uncertain retry requires a reason and possible-duplication acknowledgement",
              });
            const receipt = this.#database
              .query<
                {
                  readonly canonical_request: string;
                  readonly action_id: string;
                  readonly uncertainty_revision: number;
                },
                [string, string]
              >(
                `SELECT canonical_request, action_id, uncertainty_revision
                 FROM workflow_uncertain_retry_receipts
                 WHERE data_identity = ? AND request_id = ?`,
              )
              .get(request.dataIdentity, request.requestId);
            if (receipt !== null) {
              if (
                receipt.canonical_request !== request.canonicalRequest ||
                receipt.action_id !== request.actionId
              ) {
                throw new RunStoreError({
                  code: "REQUEST_CONFLICT",
                  message: "the retry request ID already names different canonical content",
                });
              }
              const current = this.#row(receipt.action_id);
              if (current.uncertainty_revision !== receipt.uncertainty_revision) {
                throw new RunStoreError({
                  code: "RUN_NOT_ELIGIBLE",
                  message: "a new uncertainty requires a new retry authorization request",
                });
              }
              return actionOf(current);
            }
            const action = this.#row(request.actionId);
            if (action.run_id !== request.runId || action.state !== "unresolved")
              throw new RunStoreError({
                code: "RUN_NOT_ELIGIBLE",
                message: "the exact current unresolved action was not selected",
              });
            this.#database.run(
              `UPDATE workflow_external_actions SET state = 'retry-authorized', updated_at = ?,
                 retry_reason = ?, retry_uncertainty_revision = ?, retry_authorized_at = ?,
                 retry_consumed_at = NULL WHERE action_id = ?`,
              [
                request.authorizedAt,
                request.reason.trim(),
                action.uncertainty_revision,
                request.authorizedAt,
                request.actionId,
              ],
            );
            this.#database.run(
              `INSERT INTO workflow_uncertain_retry_receipts (
                data_identity, request_id, canonical_request, action_id,
                uncertainty_revision, committed_at
              ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                request.dataIdentity,
                request.requestId,
                request.canonicalRequest,
                request.actionId,
                action.uncertainty_revision,
                request.authorizedAt,
              ],
            );
            this.#queueHeldRun(request.runId, request.authorizedAt);
            return actionOf(this.#row(request.actionId));
          })
          .immediate(),
      catch: failure,
    });

  readonly current = (
    runId: string,
  ): Effect.Effect<ExternalActionIntent | undefined, RunStoreError> =>
    Effect.try({
      try: () => {
        const row = this.#database
          .query<ActionRow, [string]>(
            `SELECT * FROM workflow_external_actions WHERE run_id = ?
             ORDER BY CASE state WHEN 'unresolved' THEN 0 WHEN 'retry-authorized' THEN 1 ELSE 2 END,
               updated_at DESC LIMIT 1`,
          )
          .get(runId);
        return row === null ? undefined : actionOf(row);
      },
      catch: failure,
    });

  readonly list = (
    runId: string,
  ): Effect.Effect<ReadonlyArray<ExternalActionIntent>, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .query<ActionRow, [string]>(
            "SELECT * FROM workflow_external_actions WHERE run_id = ? ORDER BY intended_at, action_id",
          )
          .all(runId)
          .map(actionOf),
      catch: failure,
    });
}
