import type { Database } from "bun:sqlite";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import type {
  ConfigurationChange,
  ConfigurationFieldStatus,
  ConfigurationMaintenancePlan,
  ConfigurationStatus,
  ConfigurationValue,
  DaemonConfiguration,
  ProjectConfiguration,
  RetentionCollectionResult,
} from "../models/Configuration.ts";
import {
  daemonConfigurationDefaults,
  projectConfigurationDefaults,
} from "../models/Configuration.ts";
import { ConfigurationError } from "../models/ConfigurationError.ts";
import type {
  ConfigurationRepositoryPort,
  ConfigurationTarget,
} from "../ports/ConfigurationRepository.ts";
import type { OperationRepository } from "../ports/OperationRepository.ts";

interface SettingRow {
  readonly path: string;
  readonly value_json: string;
  readonly activation: "effective" | "pending";
}

interface PlanRow {
  readonly plan_json: string;
  readonly state: "pending" | "applied";
  readonly result_json: string | null;
}

interface ConfirmedPlanResult {
  readonly plan: ConfigurationMaintenancePlan;
  readonly status: ConfigurationStatus;
  readonly collection: RetentionCollectionResult;
}

const daemonDefaults: ReadonlyMap<string, ConfigurationValue> = new Map<string, ConfigurationValue>(
  [
    ["limits.executingRuns", daemonConfigurationDefaults.limits.executingRuns],
    ["limits.newStartQueue", daemonConfigurationDefaults.limits.newStartQueue],
    ["runner.idleMs", daemonConfigurationDefaults.runner.idleMs],
    ["runner.handshakeMs", daemonConfigurationDefaults.runner.handshakeMs],
    ["runner.heartbeatMs", daemonConfigurationDefaults.runner.heartbeatMs],
    ["runner.unhealthyMs", daemonConfigurationDefaults.runner.unhealthyMs],
    ["runner.cleanupMs", daemonConfigurationDefaults.runner.cleanupMs],
    ["runner.recoveryCheckMs", daemonConfigurationDefaults.runner.recoveryCheckMs],
    ["runner.restartDelaysMs", daemonConfigurationDefaults.runner.restartDelaysMs],
    ["runner.healthyResetMs", daemonConfigurationDefaults.runner.healthyResetMs],
    ["daemon.readinessMs", daemonConfigurationDefaults.daemon.readinessMs],
    ["daemon.cleanupMs", daemonConfigurationDefaults.daemon.cleanupMs],
    ["daemon.restartDelaysMs", daemonConfigurationDefaults.daemon.restartDelaysMs],
    ["daemon.healthyResetMs", daemonConfigurationDefaults.daemon.healthyResetMs],
    ["retention.runHistoryMs", daemonConfigurationDefaults.retention.runHistoryMs],
    ["retention.traceMs", daemonConfigurationDefaults.retention.traceMs],
    ["retention.artifactMs", daemonConfigurationDefaults.retention.artifactMs],
  ],
);

const projectDefaults: ReadonlyMap<string, ConfigurationValue> = new Map<
  string,
  ConfigurationValue
>([
  ["limits.executingRuns", projectConfigurationDefaults.limits.executingRuns],
  ["limits.newStartQueue", projectConfigurationDefaults.limits.newStartQueue],
]);

const failed = (cause: unknown): ConfigurationError =>
  cause instanceof ConfigurationError
    ? cause
    : new ConfigurationError({
        code: "CONFIGURATION_STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const sameValue = (left: ConfigurationValue, right: ConfigurationValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const activationFor = (path: string): ConfigurationFieldStatus["activation"] =>
  path.startsWith("daemon.")
    ? "lifecycle-restart"
    : path.startsWith("runner.")
      ? "future-attempt"
      : "immediate";

/** Daemon-owned SQLite configuration and exact maintenance-plan adapter. */
export class SqliteConfigurationRepository implements ConfigurationRepositoryPort {
  readonly #database: Database;
  readonly #operations: OperationRepository | undefined;

  constructor(database: Database, operations?: OperationRepository) {
    this.#database = database;
    this.#operations = operations;
    database.run(`
      CREATE TABLE IF NOT EXISTS daemon_configuration_state (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        state_version INTEGER NOT NULL CHECK(state_version >= 1)
      ) STRICT
    `);
    database.run(
      "INSERT OR IGNORE INTO daemon_configuration_state (singleton, state_version) VALUES (1, 1)",
    );
    database.run(`
      CREATE TABLE IF NOT EXISTS daemon_configuration_settings (
        scope TEXT NOT NULL CHECK(scope IN ('daemon', 'project')),
        subject TEXT NOT NULL,
        path TEXT NOT NULL,
        value_json TEXT NOT NULL,
        activation TEXT NOT NULL CHECK(activation IN ('effective', 'pending')),
        PRIMARY KEY (scope, subject, path, activation)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS daemon_configuration_plans (
        plan_id TEXT PRIMARY KEY NOT NULL,
        plan_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'applied')),
        applied_at TEXT,
        result_json TEXT
      ) STRICT
    `);
    const planColumns = database
      .query<{ readonly name: string }, []>("PRAGMA table_info(daemon_configuration_plans)")
      .all();
    if (!planColumns.some((column) => column.name === "result_json")) {
      database.run("ALTER TABLE daemon_configuration_plans ADD COLUMN result_json TEXT");
    }
  }

  readonly recordOutcome = (
    mutation: MutationEnvelope,
    result: JsonValue,
  ): Effect.Effect<void, ConfigurationError> =>
    Effect.try({
      try: () => this.#database.transaction(() => this.#record(mutation, result)).immediate(),
      catch: failed,
    });

  readonly status = (
    target: ConfigurationTarget,
  ): Effect.Effect<ConfigurationStatus, ConfigurationError> =>
    Effect.try({ try: () => this.#status(target), catch: failed });

  readonly preview = (
    target: ConfigurationTarget,
    changes: ReadonlyArray<ConfigurationChange>,
  ): Effect.Effect<ConfigurationStatus, ConfigurationError> =>
    Effect.try({ try: () => this.#preview(target, changes), catch: failed });

  readonly apply = (
    target: ConfigurationTarget,
    changes: ReadonlyArray<ConfigurationChange>,
    mutation?: MutationEnvelope,
  ): Effect.Effect<ConfigurationStatus, ConfigurationError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#applyChanges(target, changes);
            this.#bumpVersion();
            const status = this.#status(target);
            if (mutation !== undefined)
              this.#record(mutation, {
                formatVersion: 1,
                status,
                collection: { runs: [], traces: [], artifacts: [] },
              } as unknown as JsonValue);
            return status;
          })
          .immediate(),
      catch: failed,
    });

  readonly savePlan = (
    plan: ConfigurationMaintenancePlan,
    operation?: { readonly mutation: MutationEnvelope; readonly result: JsonValue },
  ): Effect.Effect<void, ConfigurationError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            if (plan.expectedStateVersion !== this.#version()) {
              throw new ConfigurationError({
                code: "CONFIGURATION_PLAN_STALE",
                message: "configuration changed before the maintenance plan was retained",
              });
            }
            const encoded = JSON.stringify(plan);
            const prior = this.#database
              .query<{ readonly plan_json: string }, [string]>(
                "SELECT plan_json FROM daemon_configuration_plans WHERE plan_id = ?",
              )
              .get(plan.planId);
            if (prior !== null && prior.plan_json !== encoded) {
              throw new ConfigurationError({
                code: "CONFIGURATION_CONFLICT",
                message: "the maintenance plan ID names different content",
              });
            }
            if (prior === null) {
              this.#database.run(
                "INSERT INTO daemon_configuration_plans (plan_id, plan_json, state) VALUES (?, ?, 'pending')",
                [plan.planId, encoded],
              );
            }
            if (operation !== undefined) this.#record(operation.mutation, operation.result);
          })
          .immediate(),
      catch: failed,
    });

  readonly plan = (
    planId: string,
  ): Effect.Effect<ConfigurationMaintenancePlan | undefined, ConfigurationError> =>
    Effect.try({
      try: () => {
        const row = this.#database
          .query<PlanRow, [string]>(
            "SELECT plan_json, state, result_json FROM daemon_configuration_plans WHERE plan_id = ?",
          )
          .get(planId);
        return row === null
          ? undefined
          : (JSON.parse(row.plan_json) as ConfigurationMaintenancePlan);
      },
      catch: failed,
    });

  readonly confirmPlan = (
    planId: string,
    dataIdentity: string,
    observedAt: string,
    dataState: string,
    collect: () => RetentionCollectionResult,
    mutation?: MutationEnvelope,
  ): Effect.Effect<
    {
      readonly plan: ConfigurationMaintenancePlan;
      readonly status: ConfigurationStatus;
      readonly collection: RetentionCollectionResult;
    },
    ConfigurationError
  > =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const row = this.#database
              .query<PlanRow, [string]>(
                "SELECT plan_json, state, result_json FROM daemon_configuration_plans WHERE plan_id = ?",
              )
              .get(planId);
            if (row === null) {
              throw new ConfigurationError({
                code: "CONFIGURATION_PLAN_NOT_FOUND",
                message: "the exact configuration plan was not found",
              });
            }
            if (row.state === "applied") {
              if (row.result_json === null) {
                throw new ConfigurationError({
                  code: "CONFIGURATION_STORE_FAILED",
                  message: "the applied configuration plan has no durable result receipt",
                });
              }
              return JSON.parse(row.result_json) as ConfirmedPlanResult;
            }
            const plan = JSON.parse(row.plan_json) as ConfigurationMaintenancePlan;
            if (plan.dataIdentity !== dataIdentity) {
              throw new ConfigurationError({
                code: "CONFIGURATION_PLAN_STALE",
                message: "the maintenance plan belongs to different Daemon data",
              });
            }
            if (Date.parse(observedAt) >= Date.parse(plan.expiresAt)) {
              throw new ConfigurationError({
                code: "CONFIGURATION_PLAN_EXPIRED",
                message: "the configuration maintenance plan expired",
              });
            }
            if (
              plan.expectedStateVersion !== this.#version() ||
              plan.expectedDataState !== dataState
            ) {
              throw new ConfigurationError({
                code: "CONFIGURATION_PLAN_STALE",
                message: "configuration or retained data changed after the plan was issued",
              });
            }
            const target: ConfigurationTarget = plan.affectedScope.startsWith("project:")
              ? { scope: "project", projectId: plan.affectedScope.slice("project:".length) }
              : { scope: "daemon" };
            const collection = collect();
            this.#applyChanges(target, plan.changes);
            this.#bumpVersion();
            const result: ConfirmedPlanResult = {
              plan,
              status: this.#status(target),
              collection,
            };
            this.#database.run(
              "UPDATE daemon_configuration_plans SET state = 'applied', applied_at = ?, result_json = ? WHERE plan_id = ?",
              [observedAt, JSON.stringify(result), planId],
            );
            if (mutation !== undefined)
              this.#record(
                mutation,
                {
                  formatVersion: 1,
                  status: result.status,
                  collection: result.collection,
                } as unknown as JsonValue,
                observedAt,
              );
            return result;
          })
          .immediate(),
      catch: failed,
    });

  #record(
    mutation: MutationEnvelope,
    result: JsonValue,
    recordedAt = new Date().toISOString(),
  ): void {
    this.#operations?.record(
      mutation,
      {
        receiptVersion: 1,
        requestId: mutation.requestId,
        dataIdentity: mutation.dataIdentity,
        operation: mutation.operation,
        status: "committed",
        result,
      },
      recordedAt,
    );
  }

  daemonConfiguration(): DaemonConfiguration {
    const values = this.#values({ scope: "daemon" }, "effective");
    const value = <A extends ConfigurationValue>(path: string): A =>
      (values.get(path) ?? daemonDefaults.get(path)) as A;
    return {
      limits: {
        executingRuns: value<number>("limits.executingRuns"),
        newStartQueue: value<number>("limits.newStartQueue"),
      },
      runner: {
        idleMs: value<number>("runner.idleMs"),
        handshakeMs: value<number>("runner.handshakeMs"),
        heartbeatMs: value<number>("runner.heartbeatMs"),
        unhealthyMs: value<number>("runner.unhealthyMs"),
        cleanupMs: value<number>("runner.cleanupMs"),
        recoveryCheckMs: value<number>("runner.recoveryCheckMs"),
        restartDelaysMs: value<ReadonlyArray<number>>("runner.restartDelaysMs"),
        healthyResetMs: value<number>("runner.healthyResetMs"),
      },
      daemon: {
        readinessMs: value<number>("daemon.readinessMs"),
        cleanupMs: value<number>("daemon.cleanupMs"),
        restartDelaysMs: value<ReadonlyArray<number>>("daemon.restartDelaysMs"),
        healthyResetMs: value<number>("daemon.healthyResetMs"),
      },
      retention: {
        runHistoryMs: value<number | "indefinite">("retention.runHistoryMs"),
        traceMs: value<number | "indefinite">("retention.traceMs"),
        artifactMs: value<number | "indefinite">("retention.artifactMs"),
      },
    };
  }

  projectConfiguration(projectId: string): ProjectConfiguration {
    const values = this.#values({ scope: "project", projectId }, "effective");
    return {
      limits: {
        executingRuns: (values.get("limits.executingRuns") ??
          projectConfigurationDefaults.limits.executingRuns) as number,
        newStartQueue: (values.get("limits.newStartQueue") ??
          projectConfigurationDefaults.limits.newStartQueue) as number,
      },
    };
  }

  readonly activatePendingDaemon = (): Effect.Effect<ConfigurationStatus, ConfigurationError> =>
    Effect.try({
      try: () => {
        this.#activatePendingDaemonNow();
        return this.#status({ scope: "daemon" });
      },
      catch: failed,
    });

  #activatePendingDaemonNow(): void {
    this.#database
      .transaction(() => {
        const pending = this.#rows({ scope: "daemon" }).filter(
          (row) => row.activation === "pending",
        );
        if (pending.length === 0) return;
        for (const row of pending) {
          const defaultValue = daemonDefaults.get(row.path);
          if (
            defaultValue !== undefined &&
            sameValue(JSON.parse(row.value_json) as ConfigurationValue, defaultValue)
          ) {
            this.#database.run(
              "DELETE FROM daemon_configuration_settings WHERE scope = 'daemon' AND subject = '' AND path = ? AND activation = 'effective'",
              [row.path],
            );
          } else {
            this.#database.run(
              `INSERT INTO daemon_configuration_settings (scope, subject, path, value_json, activation)
               VALUES ('daemon', '', ?, ?, 'effective')
               ON CONFLICT(scope, subject, path, activation) DO UPDATE SET value_json = excluded.value_json`,
              [row.path, row.value_json],
            );
          }
        }
        this.#database.run(
          "DELETE FROM daemon_configuration_settings WHERE scope = 'daemon' AND subject = '' AND activation = 'pending'",
        );
        this.#bumpVersion();
      })
      .immediate();
  }

  #target(target: ConfigurationTarget): { readonly scope: string; readonly subject: string } {
    return target.scope === "daemon"
      ? { scope: "daemon", subject: "" }
      : { scope: "project", subject: target.projectId };
  }

  #rows(target: ConfigurationTarget): ReadonlyArray<SettingRow> {
    const selected = this.#target(target);
    return this.#database
      .query<SettingRow, [string, string]>(
        "SELECT path, value_json, activation FROM daemon_configuration_settings WHERE scope = ? AND subject = ? ORDER BY path, activation",
      )
      .all(selected.scope, selected.subject);
  }

  #values(
    target: ConfigurationTarget,
    activation: "effective" | "pending",
  ): Map<string, ConfigurationValue> {
    return new Map(
      this.#rows(target)
        .filter((row) => row.activation === activation)
        .map((row) => [row.path, JSON.parse(row.value_json) as ConfigurationValue]),
    );
  }

  #status(target: ConfigurationTarget): ConfigurationStatus {
    const defaults = target.scope === "daemon" ? daemonDefaults : projectDefaults;
    const effective = this.#values(target, "effective");
    const pending = this.#values(target, "pending");
    const fields = [...defaults.entries()].map(([path, defaultValue]) => ({
      path,
      effective: effective.get(path) ?? defaultValue,
      default: defaultValue,
      scope: target.scope,
      activation: target.scope === "project" ? ("immediate" as const) : activationFor(path),
      ...(pending.has(path) ? { pending: pending.get(path) as ConfigurationValue } : {}),
    }));
    return {
      formatVersion: 1,
      scope: target.scope,
      ...(target.scope === "project" ? { projectId: target.projectId } : {}),
      stateVersion: this.#version(),
      restartRequired: pending.size > 0,
      fields,
    };
  }

  #preview(
    target: ConfigurationTarget,
    changes: ReadonlyArray<ConfigurationChange>,
  ): ConfigurationStatus {
    const status = this.#status(target);
    const defaults = target.scope === "daemon" ? daemonDefaults : projectDefaults;
    const changed = new Map<string, ConfigurationChange>(
      changes.map((change) => [change.path, change]),
    );
    const fields: ReadonlyArray<ConfigurationFieldStatus> = status.fields.map((field) => {
      const change = changed.get(field.path);
      if (change === undefined) return field;
      const value = change.reset ? (defaults.get(field.path) as ConfigurationValue) : change.value;
      if (field.activation === "lifecycle-restart") {
        const { pending: _pending, ...withoutPending } = field;
        return sameValue(value, field.effective)
          ? withoutPending
          : { ...withoutPending, pending: value };
      }
      return { ...field, effective: value };
    });
    return {
      ...status,
      restartRequired: fields.some((field) => field.pending !== undefined),
      fields,
    };
  }

  #applyChanges(target: ConfigurationTarget, changes: ReadonlyArray<ConfigurationChange>): void {
    const selected = this.#target(target);
    const defaults = target.scope === "daemon" ? daemonDefaults : projectDefaults;
    for (const change of changes) {
      const activation =
        target.scope === "daemon" && change.path.startsWith("daemon.") ? "pending" : "effective";
      const value = change.reset ? defaults.get(change.path) : change.value;
      if (value === undefined) {
        throw new ConfigurationError({
          code: "INVALID_CONFIGURATION_PATCH",
          message: `unknown ${target.scope} setting ${change.path}`,
        });
      }
      if (change.reset && activation === "effective") {
        this.#database.run(
          "DELETE FROM daemon_configuration_settings WHERE scope = ? AND subject = ? AND path = ? AND activation = ?",
          [selected.scope, selected.subject, change.path, activation],
        );
        continue;
      }
      if (activation === "pending") {
        const defaultValue = defaults.get(change.path) as ConfigurationValue;
        const effective = this.#values(target, "effective").get(change.path) ?? defaultValue;
        if (sameValue(value, effective)) {
          this.#database.run(
            "DELETE FROM daemon_configuration_settings WHERE scope = ? AND subject = ? AND path = ? AND activation = 'pending'",
            [selected.scope, selected.subject, change.path],
          );
          continue;
        }
      }
      const current = this.#database
        .query<{ readonly value_json: string }, [string, string, string, string]>(
          "SELECT value_json FROM daemon_configuration_settings WHERE scope = ? AND subject = ? AND path = ? AND activation = ?",
        )
        .get(selected.scope, selected.subject, change.path, activation);
      if (current !== null && sameValue(JSON.parse(current.value_json), value)) continue;
      this.#database.run(
        `INSERT INTO daemon_configuration_settings (scope, subject, path, value_json, activation)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, subject, path, activation) DO UPDATE SET value_json = excluded.value_json`,
        [selected.scope, selected.subject, change.path, JSON.stringify(value), activation],
      );
    }
  }

  #version(): number {
    return (
      this.#database
        .query<{ readonly state_version: number }, []>(
          "SELECT state_version FROM daemon_configuration_state WHERE singleton = 1",
        )
        .get()?.state_version ?? 1
    );
  }

  #bumpVersion(): void {
    this.#database.run(
      "UPDATE daemon_configuration_state SET state_version = state_version + 1 WHERE singleton = 1",
    );
  }
}
