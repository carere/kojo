import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import {
  DEFAULT_RUNNER_HEALTHY_RESET_MILLIS,
  DEFAULT_RUNNER_REPLACEMENT_DELAYS_MILLIS,
  type ProjectRecovery,
  type RunnerFailure,
} from "../models/ProjectRecovery.ts";
import { ProjectRecoveryStoreError } from "../models/ProjectRecoveryStoreError.ts";

interface RecoveryRow {
  readonly project_id: string;
  readonly cycle: number;
  readonly attempts: number;
  readonly state: "healthy" | "recovering" | "held";
  readonly safety: "safe" | "pending" | "uncertain";
  readonly failed_operation_pending: number;
  readonly healthy_since: string | null;
  readonly next_attempt_at: string | null;
  readonly prior_runner_instance_id: string | null;
  readonly last_fault: string | null;
}

const recoveryOf = (row: RecoveryRow): ProjectRecovery => ({
  projectId: row.project_id,
  cycle: row.cycle,
  attempts: row.attempts,
  state: row.state,
  safety: row.safety,
  failedOperationPending: row.failed_operation_pending === 1,
  ...(row.healthy_since === null ? {} : { healthySince: row.healthy_since }),
  ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
  ...(row.prior_runner_instance_id === null
    ? {}
    : { priorRunnerInstanceId: row.prior_runner_instance_id }),
  ...(row.last_fault === null ? {} : { lastFault: row.last_fault }),
});

const storeError = (cause: unknown): ProjectRecoveryStoreError =>
  cause instanceof ProjectRecoveryStoreError
    ? cause
    : new ProjectRecoveryStoreError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

/** SQLite adapter for Project recovery. The table is Daemon-owned and survives its process. */
export class SqliteProjectRecoveryRepository {
  readonly #database: Database;
  readonly #delays: ReadonlyArray<number>;
  readonly #healthyResetMillis: number;

  constructor(
    database: Database,
    options: {
      readonly replacementDelaysMillis?: ReadonlyArray<number>;
      readonly healthyResetMillis?: number;
    } = {},
  ) {
    this.#database = database;
    this.#delays = options.replacementDelaysMillis ?? DEFAULT_RUNNER_REPLACEMENT_DELAYS_MILLIS;
    this.#healthyResetMillis = options.healthyResetMillis ?? DEFAULT_RUNNER_HEALTHY_RESET_MILLIS;
    database.run(`
      CREATE TABLE IF NOT EXISTS project_runner_recovery (
        project_id TEXT PRIMARY KEY NOT NULL,
        cycle INTEGER NOT NULL CHECK(cycle >= 1),
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        state TEXT NOT NULL CHECK(state IN ('healthy', 'recovering', 'held')),
        safety TEXT NOT NULL CHECK(safety IN ('safe', 'pending', 'uncertain')),
        failed_operation_pending INTEGER NOT NULL CHECK(failed_operation_pending IN (0, 1)),
        healthy_since TEXT,
        next_attempt_at TEXT,
        prior_runner_instance_id TEXT,
        last_fault TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      ) STRICT
    `);
  }

  readonly read = (
    projectId: string,
  ): Effect.Effect<ProjectRecovery | undefined, ProjectRecoveryStoreError> =>
    Effect.try({
      try: () => {
        const row = this.#row(projectId);
        return row === null ? undefined : recoveryOf(row);
      },
      catch: storeError,
    });

  readonly recoveries: Effect.Effect<ReadonlyArray<ProjectRecovery>, ProjectRecoveryStoreError> =
    Effect.try({
      try: () =>
        this.#database
          .query<RecoveryRow, []>(
            `SELECT project_id, cycle, attempts, state, safety, failed_operation_pending,
                  healthy_since, next_attempt_at, prior_runner_instance_id, last_fault
             FROM project_runner_recovery ORDER BY project_id`,
          )
          .all()
          .map(recoveryOf),
      catch: storeError,
    });

  readonly recordFailure = (
    failure: RunnerFailure,
  ): Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const prior = this.#row(failure.projectId);
            const attempted = (prior?.attempts ?? 0) + 1;
            const exhausted = attempted > this.#delays.length;
            const attempts = Math.min(attempted, this.#delays.length);
            const delay = this.#delays[Math.min(attempted, this.#delays.length) - 1] ?? 0;
            this.#database.run(
              `INSERT INTO project_runner_recovery (
                 project_id, cycle, attempts, state, safety, failed_operation_pending,
                 healthy_since, next_attempt_at, prior_runner_instance_id, last_fault
               ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?)
               ON CONFLICT(project_id) DO UPDATE SET
                 attempts = excluded.attempts,
                 state = excluded.state,
                 safety = 'pending',
                 failed_operation_pending = excluded.failed_operation_pending,
                 healthy_since = NULL,
                 next_attempt_at = excluded.next_attempt_at,
                 prior_runner_instance_id = excluded.prior_runner_instance_id,
                 last_fault = excluded.last_fault`,
              [
                failure.projectId,
                prior?.cycle ?? 1,
                attempts,
                exhausted ? "held" : "recovering",
                failure.operationFailed || prior?.failed_operation_pending === 1 ? 1 : 0,
                new Date(Date.parse(failure.failedAt) + delay).toISOString(),
                failure.runnerInstanceId,
                failure.fault,
              ],
            );
            return recoveryOf(this.#required(failure.projectId));
          })
          .immediate(),
      catch: storeError,
    });

  readonly confirmSafety = (
    projectId: string,
    runnerInstanceId: string,
    _confirmedAt: string,
  ): Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError> =>
    this.#change(projectId, (prior) => {
      this.#assertPriorRunner(prior, runnerInstanceId);
      this.#database.run(
        "UPDATE project_runner_recovery SET safety = 'safe' WHERE project_id = ?",
        [projectId],
      );
    });

  readonly holdUncertain = (
    projectId: string,
    runnerInstanceId: string,
    detail: string,
  ): Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError> =>
    this.#change(projectId, (prior) => {
      this.#assertPriorRunner(prior, runnerInstanceId);
      this.#database.run(
        `UPDATE project_runner_recovery
            SET state = 'held', safety = 'uncertain', last_fault = ?
          WHERE project_id = ?`,
        [detail, projectId],
      );
    });

  readonly observeHealthy = (
    projectId: string,
    observedAt: string,
    operationSucceeded: boolean,
  ): Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError> =>
    this.#change(projectId, (prior) => {
      if (prior.state === "held" || prior.safety !== "safe") return;
      const healthySince = prior.healthy_since ?? observedAt;
      const failedOperationPending = operationSucceeded ? 0 : prior.failed_operation_pending;
      if (
        Date.parse(observedAt) - Date.parse(healthySince) >= this.#healthyResetMillis &&
        failedOperationPending === 0
      ) {
        this.#database.run(
          `UPDATE project_runner_recovery
              SET attempts = 0, state = 'healthy', failed_operation_pending = 0,
                  healthy_since = ?, next_attempt_at = NULL,
                  prior_runner_instance_id = NULL, last_fault = NULL
            WHERE project_id = ?`,
          [observedAt, projectId],
        );
        return;
      }
      this.#database.run(
        `UPDATE project_runner_recovery
            SET healthy_since = ?, failed_operation_pending = ?
          WHERE project_id = ?`,
        [healthySince, failedOperationPending, projectId],
      );
    });

  readonly repair = (
    projectId: string,
    _requestedAt: string,
  ): Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError> =>
    Effect.try({
      try: () => {
        if (this.#row(projectId) === null) {
          return {
            projectId,
            cycle: 1,
            attempts: 0,
            state: "healthy",
            safety: "safe",
            failedOperationPending: false,
          };
        }
        return this.#database
          .transaction(() => {
            const prior = this.#required(projectId);
            if (prior.state !== "held" || prior.safety !== "safe") return recoveryOf(prior);
            this.#database.run(
              `UPDATE project_runner_recovery
                  SET cycle = cycle + 1, attempts = 0, state = 'recovering',
                      healthy_since = NULL, next_attempt_at = NULL
                WHERE project_id = ?`,
              [projectId],
            );
            return recoveryOf(this.#required(projectId));
          })
          .immediate();
      },
      catch: storeError,
    });

  #change(
    projectId: string,
    update: (prior: RecoveryRow) => void,
  ): Effect.Effect<ProjectRecovery, ProjectRecoveryStoreError> {
    return Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const prior = this.#required(projectId);
            update(prior);
            return recoveryOf(this.#required(projectId));
          })
          .immediate(),
      catch: storeError,
    });
  }

  #assertPriorRunner(prior: RecoveryRow, runnerInstanceId: string): void {
    if (prior.prior_runner_instance_id !== runnerInstanceId) {
      throw new ProjectRecoveryStoreError({
        message: "termination evidence does not name the failed Project Runner instance",
      });
    }
  }

  #required(projectId: string): RecoveryRow {
    const row = this.#row(projectId);
    if (row === null)
      throw new ProjectRecoveryStoreError({ message: "Project recovery was not started" });
    return row;
  }

  #row(projectId: string): RecoveryRow | null {
    return this.#database
      .query<RecoveryRow, [string]>(
        `SELECT project_id, cycle, attempts, state, safety, failed_operation_pending,
                healthy_since, next_attempt_at, prior_runner_instance_id, last_fault
           FROM project_runner_recovery WHERE project_id = ?`,
      )
      .get(projectId);
  }
}
