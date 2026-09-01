import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { rebuildSqliteTableWithoutForeignKey } from "../../shared/adapters/rebuildSqliteTableWithoutForeignKey.ts";
import type { RunAuthority } from "../../workflow/models/DaemonRun.ts";
import type {
  CreateAsking,
  DaemonAsking,
  DeferredApplication,
  GateTransitionReceipt,
  RecordVerdictTransition,
} from "../models/DaemonAsking.ts";
import { GateTransitionError } from "../models/GateTransitionError.ts";

interface AskingRow {
  readonly identity_key: string;
  readonly token: string;
  readonly run_id: string;
  readonly project_id: string;
  readonly workflow_name: string;
  readonly gate_path: string;
  readonly asking_number: number;
  readonly escalation_stage: number;
  readonly description: string;
  readonly actor: string;
  readonly choices_json: string;
  readonly deadline: string;
  readonly expiry_branch: "fail" | "reject" | "escalate";
  readonly internal_deferred_name: string;
  readonly created_at: string;
  readonly state: "unanswered" | "recorded" | "applied" | "expired";
  readonly verdict_choice: string | null;
  readonly verdict_reason: string | null;
  readonly answerer: string | null;
  readonly recorded_at: string | null;
  readonly applied_at: string | null;
  readonly expired_at: string | null;
  readonly expiry_applied_at: string | null;
  readonly terminal_inability: "run-cancelled" | "run-failed" | null;
}

interface ReceiptRow {
  readonly canonical_request: string;
  readonly token: string;
}

interface WakeupRow {
  readonly wakeup_id: string;
  readonly deferred_name: string;
  readonly kind: DeferredApplication["kind"];
  readonly verdict_json: string | null;
}

const identityKey = (asking: CreateAsking | DaemonAsking): string =>
  JSON.stringify([
    1,
    asking.identity.runId,
    asking.identity.gatePath,
    asking.identity.askingNumber,
    asking.identity.escalationStage,
  ]);

const wakeupId = (key: string, kind: "verdict" | "expiry"): string =>
  JSON.stringify([1, key, kind]);

const askingOf = (row: AskingRow): DaemonAsking => ({
  identity: {
    identityVersion: 1,
    runId: row.run_id,
    gatePath: row.gate_path,
    askingNumber: row.asking_number,
    escalationStage: row.escalation_stage,
  },
  token: row.token,
  projectId: row.project_id,
  workflowName: row.workflow_name,
  description: row.description,
  actor: row.actor,
  choices: JSON.parse(row.choices_json) as ReadonlyArray<string>,
  deadline: row.deadline,
  expiryBranch: row.expiry_branch,
  internalDeferredName: row.internal_deferred_name,
  createdAt: row.created_at,
  state: row.state,
  ...(row.recorded_at === null ||
  row.verdict_choice === null ||
  row.verdict_reason === null ||
  row.answerer === null
    ? {}
    : {
        verdict: {
          choice: row.verdict_choice,
          reason: row.verdict_reason,
          answerer: row.answerer,
          recordedAt: row.recorded_at,
        },
      }),
  ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
  ...(row.expired_at === null ? {} : { expiredAt: row.expired_at }),
  ...(row.expiry_applied_at === null ? {} : { expiryAppliedAt: row.expiry_applied_at }),
  ...(row.terminal_inability === null ? {} : { terminalInability: row.terminal_inability }),
});

const fault = (cause: unknown): GateTransitionError =>
  cause instanceof GateTransitionError
    ? cause
    : new GateTransitionError({
        code: "STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

/** Sole-owner SQLite Gate repository. Each method commits one complete domain transition. */
export class SqliteDaemonGateRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE IF NOT EXISTS gate_askings (
        identity_key TEXT PRIMARY KEY NOT NULL,
        token TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        gate_path TEXT NOT NULL,
        asking_number INTEGER NOT NULL,
        escalation_stage INTEGER NOT NULL,
        description TEXT NOT NULL,
        actor TEXT NOT NULL,
        choices_json TEXT NOT NULL,
        deadline TEXT NOT NULL,
        expiry_branch TEXT NOT NULL CHECK(expiry_branch IN ('fail', 'reject', 'escalate')),
        internal_deferred_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('unanswered', 'recorded', 'applied', 'expired')),
        verdict_choice TEXT,
        verdict_reason TEXT,
        answerer TEXT,
        recorded_at TEXT,
        applied_at TEXT,
        expired_at TEXT,
        expiry_applied_at TEXT,
        terminal_inability TEXT CHECK(terminal_inability IS NULL OR terminal_inability IN ('run-cancelled', 'run-failed')),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(
      "CREATE INDEX IF NOT EXISTS gate_askings_deadline ON gate_askings(state, deadline)",
    );
    database.run(`
      CREATE TABLE IF NOT EXISTS gate_answer_receipts (
        data_identity TEXT NOT NULL,
        request_id TEXT NOT NULL,
        canonical_request TEXT NOT NULL,
        token TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (data_identity, request_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_wakeups (
        wakeup_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        asking_identity_key TEXT NOT NULL,
        deferred_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('verdict', 'expiry')),
        due_at TEXT NOT NULL,
        verdict_json TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending', 'applied')),
        applied_at TEXT,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id),
        FOREIGN KEY (asking_identity_key) REFERENCES gate_askings(identity_key)
      ) STRICT
    `);
    database.run(
      "CREATE INDEX IF NOT EXISTS workflow_wakeups_due ON workflow_wakeups(state, due_at)",
    );
    rebuildSqliteTableWithoutForeignKey(database, {
      table: "gate_answer_receipts",
      temporary: "gate_answer_receipts_retention",
      referencedTable: "gate_askings",
      createTemporary: `CREATE TABLE gate_answer_receipts_retention (
        data_identity TEXT NOT NULL,
        request_id TEXT NOT NULL,
        canonical_request TEXT NOT NULL,
        token TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (data_identity, request_id)
      ) STRICT`,
      columns: "data_identity, request_id, canonical_request, token, committed_at",
    });
  }

  readonly createAskingAndSuspend = (
    authority: RunAuthority,
    asking: CreateAsking,
  ): Effect.Effect<DaemonAsking, GateTransitionError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            const key = identityKey(asking);
            const prior = this.#database
              .query<AskingRow, [string]>("SELECT * FROM gate_askings WHERE identity_key = ?")
              .get(key);
            if (prior !== null) {
              if (
                prior.token !== asking.token ||
                prior.internal_deferred_name !== asking.internalDeferredName ||
                prior.deadline !== asking.deadline
              ) {
                throw new GateTransitionError({
                  code: "ASKING_CONFLICT",
                  message: "the Asking identity already has different content",
                });
              }
              return askingOf(prior);
            }
            this.#database.run(
              `INSERT INTO gate_askings (
              identity_key, token, run_id, project_id, workflow_name, gate_path,
              asking_number, escalation_stage, description, actor, choices_json,
              deadline, expiry_branch, internal_deferred_name, created_at, state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unanswered')`,
              [
                key,
                asking.token,
                asking.identity.runId,
                asking.projectId,
                asking.workflowName,
                asking.identity.gatePath,
                asking.identity.askingNumber,
                asking.identity.escalationStage,
                asking.description,
                asking.actor,
                JSON.stringify(asking.choices),
                asking.deadline,
                asking.expiryBranch,
                asking.internalDeferredName,
                asking.createdAt,
              ],
            );
            this.#database.run("UPDATE workflow_runs SET state = 'suspended' WHERE run_id = ?", [
              authority.runId,
            ]);
            this.#database.run("DELETE FROM workflow_slots WHERE run_id = ?", [authority.runId]);
            this.#database.run("DELETE FROM workflow_claims WHERE run_id = ?", [authority.runId]);
            return askingOf(this.#rowByToken(asking.token));
          })
          .immediate(),
      catch: fault,
    });

  readonly recordVerdictAndSchedule = (
    request: RecordVerdictTransition,
  ): Effect.Effect<GateTransitionReceipt, GateTransitionError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const priorReceipt = this.#database
              .query<ReceiptRow, [string, string]>(
                "SELECT canonical_request, token FROM gate_answer_receipts WHERE data_identity = ? AND request_id = ?",
              )
              .get(request.dataIdentity, request.requestId);
            if (priorReceipt !== null) {
              if (priorReceipt.canonical_request !== request.canonicalRequest) {
                throw new GateTransitionError({
                  code: "REQUEST_CONFLICT",
                  message: "the request ID names different canonical content",
                });
              }
              return {
                asking: askingOf(this.#rowByToken(priorReceipt.token)),
                requestId: request.requestId,
                duplicate: true,
              };
            }
            const row = this.#rowByToken(request.token);
            if (Date.parse(request.now) >= Date.parse(row.deadline)) {
              this.#expire(row, request.now);
              return {
                asking: askingOf(this.#rowByToken(request.token)),
                requestId: request.requestId,
                duplicate: false,
                late: true,
              };
            }
            if (row.state !== "unanswered") {
              throw new GateTransitionError({
                code: "ALREADY_SETTLED",
                message: "the Asking already has a Verdict or expiry",
              });
            }
            const choices = JSON.parse(row.choices_json) as ReadonlyArray<string>;
            if (!choices.includes(request.choice)) {
              throw new GateTransitionError({
                code: "CHOICE_REFUSED",
                message: "the Verdict choice is not declared by this Asking",
              });
            }
            this.#database.run(
              `UPDATE gate_askings
                SET state = 'recorded', verdict_choice = ?, verdict_reason = ?, answerer = ?, recorded_at = ?
              WHERE token = ? AND state = 'unanswered'`,
              [request.choice, request.reason, request.answerer, request.now, request.token],
            );
            const updated = this.#rowByToken(request.token);
            const key = updated.identity_key;
            const verdict = askingOf(updated).verdict;
            const terminalInability = this.#terminalInability(updated.run_id);
            if (terminalInability === undefined) {
              this.#schedule(
                updated,
                "verdict",
                updated.internal_deferred_name,
                request.now,
                verdict ?? null,
              );
            } else {
              this.#database.run(
                "UPDATE gate_askings SET terminal_inability = ? WHERE identity_key = ?",
                [terminalInability, updated.identity_key],
              );
            }
            this.#database.run(
              "INSERT INTO gate_answer_receipts (data_identity, request_id, canonical_request, token, committed_at) VALUES (?, ?, ?, ?, ?)",
              [
                request.dataIdentity,
                request.requestId,
                request.canonicalRequest,
                request.token,
                request.now,
              ],
            );
            return {
              asking: askingOf(this.#rowByToken(request.token)),
              requestId: request.requestId,
              duplicate: false,
              late: false,
              key,
            };
          })
          .immediate(),
      catch: fault,
    }).pipe(
      Effect.flatMap((receipt) => {
        const result = receipt as GateTransitionReceipt & { readonly late?: boolean };
        return result.late
          ? Effect.fail(
              new GateTransitionError({
                code: "DEADLINE_PASSED",
                message: "the Verdict was not recorded before the Deadline",
              }),
            )
          : Effect.succeed({
              asking: result.asking,
              requestId: result.requestId,
              duplicate: result.duplicate,
            });
      }),
    );

  readonly expireAndSchedule = (
    token: string,
    now: string,
  ): Effect.Effect<DaemonAsking, GateTransitionError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const row = this.#rowByToken(token);
            if (row.state === "recorded" || row.state === "applied") return askingOf(row);
            if (Date.parse(now) < Date.parse(row.deadline)) {
              throw new GateTransitionError({
                code: "DEADLINE_PASSED",
                message: "the Asking has not reached its Deadline",
              });
            }
            this.#expire(row, now);
            return askingOf(this.#rowByToken(token));
          })
          .immediate(),
      catch: fault,
    });

  readonly markApplied = (
    authority: RunAuthority,
    id: string,
    appliedAt: string,
  ): Effect.Effect<DaemonAsking, GateTransitionError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            const wakeup = this.#database
              .query<
                WakeupRow & { readonly asking_identity_key: string; readonly state: string },
                [string]
              >(
                "SELECT wakeup_id, asking_identity_key, deferred_name, kind, verdict_json, state FROM workflow_wakeups WHERE wakeup_id = ?",
              )
              .get(id);
            if (wakeup === null) {
              throw new GateTransitionError({
                code: "ASKING_NOT_FOUND",
                message: "the wake-up was not found",
              });
            }
            if (wakeup.state !== "applied") {
              this.#database.run(
                "UPDATE workflow_wakeups SET state = 'applied', applied_at = ? WHERE wakeup_id = ?",
                [appliedAt, id],
              );
              this.#database.run(
                wakeup.kind === "verdict"
                  ? "UPDATE gate_askings SET state = 'applied', applied_at = ? WHERE identity_key = ?"
                  : "UPDATE gate_askings SET expiry_applied_at = ? WHERE identity_key = ?",
                [appliedAt, wakeup.asking_identity_key],
              );
            }
            return askingOf(
              this.#database
                .query<AskingRow, [string]>("SELECT * FROM gate_askings WHERE identity_key = ?")
                .get(wakeup.asking_identity_key) as AskingRow,
            );
          })
          .immediate(),
      catch: fault,
    });

  readonly byToken = (
    token: string,
  ): Effect.Effect<DaemonAsking | undefined, GateTransitionError> =>
    Effect.try({
      try: () => {
        const row = this.#database
          .query<AskingRow, [string]>("SELECT * FROM gate_askings WHERE token = ?")
          .get(token);
        return row === null ? undefined : askingOf(row);
      },
      catch: fault,
    });

  readonly list: Effect.Effect<ReadonlyArray<DaemonAsking>, GateTransitionError> = Effect.try({
    try: () =>
      this.#database
        .query<AskingRow, []>("SELECT * FROM gate_askings ORDER BY created_at DESC")
        .all()
        .map(askingOf),
    catch: fault,
  });

  readonly due = (now: string): Effect.Effect<ReadonlyArray<DaemonAsking>, GateTransitionError> =>
    Effect.try({
      try: () =>
        this.#database
          .query<AskingRow, [string]>(
            "SELECT * FROM gate_askings WHERE state = 'unanswered' AND deadline <= ? ORDER BY deadline",
          )
          .all(now)
          .map(askingOf),
      catch: fault,
    });

  readonly deferredApplications = (
    runId: string,
  ): Effect.Effect<ReadonlyArray<DeferredApplication>, GateTransitionError> =>
    Effect.try({
      try: () =>
        this.#database
          .query<WakeupRow, [string]>(
            "SELECT wakeup_id, deferred_name, kind, verdict_json FROM workflow_wakeups WHERE run_id = ? AND state = 'pending' ORDER BY due_at, wakeup_id",
          )
          .all(runId)
          .map((row) => ({
            wakeupId: row.wakeup_id,
            deferredName: row.deferred_name,
            kind: row.kind,
            result: row.verdict_json === null ? null : JSON.parse(row.verdict_json),
          })),
      catch: fault,
    });

  /**
   * Read every committed Deferred result for replay, including a wake-up already marked Applied.
   *
   * Applied is an acknowledgement. It is not permission to delete the value that a fresh Runner
   * must read when the Daemon stopped before it could commit the Run completion.
   */
  readonly deferredResults = (
    runId: string,
  ): Effect.Effect<ReadonlyArray<DeferredApplication>, GateTransitionError> =>
    Effect.try({
      try: () =>
        this.#database
          .query<WakeupRow, [string]>(
            "SELECT wakeup_id, deferred_name, kind, verdict_json FROM workflow_wakeups WHERE run_id = ? ORDER BY due_at, wakeup_id",
          )
          .all(runId)
          .map((row) => ({
            wakeupId: row.wakeup_id,
            deferredName: row.deferred_name,
            kind: row.kind,
            result: row.verdict_json === null ? null : JSON.parse(row.verdict_json),
          })),
      catch: fault,
    });

  /** Persist a Recorded Verdict that can no longer be applied after a terminal Run transition. */
  readonly reconcileTerminalInabilities = (): Effect.Effect<void, GateTransitionError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#database.run(`
              UPDATE gate_askings
                 SET terminal_inability = (
                   SELECT CASE workflow_runs.state
                     WHEN 'failed' THEN 'run-failed'
                     WHEN 'cancelled' THEN 'run-cancelled'
                   END
                     FROM workflow_runs
                    WHERE workflow_runs.run_id = gate_askings.run_id
                 )
               WHERE state = 'recorded'
                 AND terminal_inability IS NULL
                 AND run_id IN (
                   SELECT run_id FROM workflow_runs WHERE state IN ('failed', 'cancelled')
                 )
            `);
            this.#database.run(`
              DELETE FROM workflow_wakeups
               WHERE state = 'pending'
                 AND asking_identity_key IN (
                   SELECT identity_key FROM gate_askings WHERE terminal_inability IS NOT NULL
                 )
            `);
          })
          .immediate(),
      catch: fault,
    });

  #rowByToken(token: string): AskingRow {
    const row = this.#database
      .query<AskingRow, [string]>("SELECT * FROM gate_askings WHERE token = ?")
      .get(token);
    if (row === null) {
      throw new GateTransitionError({
        code: "ASKING_NOT_FOUND",
        message: "the Gate token was not found",
      });
    }
    return row;
  }

  #terminalInability(runId: string): "run-cancelled" | "run-failed" | undefined {
    const run = this.#database
      .query<{ readonly state: string }, [string]>(
        "SELECT state FROM workflow_runs WHERE run_id = ?",
      )
      .get(runId);
    if (run?.state === "failed") return "run-failed";
    if (run?.state === "cancelled") return "run-cancelled";
    return undefined;
  }

  #assertAuthority(authority: RunAuthority): void {
    const row = this.#database
      .query<
        {
          readonly runner_instance_id: string;
          readonly generation: number;
          readonly revision_id: string;
          readonly slot_runner_instance_id: string;
          readonly slot_generation: number;
        },
        [string]
      >(
        `SELECT claims.runner_instance_id, claims.generation, claims.revision_id,
                slots.runner_instance_id AS slot_runner_instance_id,
                slots.generation AS slot_generation
           FROM workflow_claims AS claims
           JOIN workflow_slots AS slots ON slots.run_id = claims.run_id
          WHERE claims.run_id = ?`,
      )
      .get(authority.runId);
    if (
      row === null ||
      row.runner_instance_id !== authority.runnerInstanceId ||
      row.generation !== authority.generation ||
      row.revision_id !== authority.revisionId ||
      row.slot_runner_instance_id !== authority.runnerInstanceId ||
      row.slot_generation !== authority.generation
    ) {
      throw new GateTransitionError({
        code: "STALE_AUTHORITY",
        message: "the Runner authority is stale",
      });
    }
  }

  #queue(row: AskingRow, queuedAt: string): void {
    this.#database.run(
      "UPDATE workflow_runs SET state = 'queued' WHERE run_id = ? AND state = 'suspended'",
      [row.run_id],
    );
    this.#database.run(
      `INSERT INTO workflow_queue (run_id, project_id, admission_sequence, queued_at)
       SELECT run_id, project_id, admission_sequence, ? FROM workflow_runs WHERE run_id = ?
       ON CONFLICT(run_id) DO NOTHING`,
      [queuedAt, row.run_id],
    );
  }

  #schedule(
    row: AskingRow,
    kind: "verdict" | "expiry",
    deferredName: string,
    dueAt: string,
    verdict: unknown,
  ): void {
    this.#database.run(
      `INSERT INTO workflow_wakeups (
        wakeup_id, run_id, asking_identity_key, deferred_name, kind, due_at, verdict_json, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      ON CONFLICT(wakeup_id) DO NOTHING`,
      [
        wakeupId(row.identity_key, kind),
        row.run_id,
        row.identity_key,
        deferredName,
        kind,
        dueAt,
        verdict === null ? null : JSON.stringify(verdict),
      ],
    );
    this.#queue(row, dueAt);
  }

  #expire(row: AskingRow, now: string): void {
    if (row.state !== "unanswered") return;
    this.#database.run(
      "UPDATE gate_askings SET state = 'expired', expired_at = deadline WHERE identity_key = ? AND state = 'unanswered'",
      [row.identity_key],
    );
    this.#schedule(row, "expiry", `DurableClock/${row.internal_deferred_name}/deadline`, now, null);
  }
}
