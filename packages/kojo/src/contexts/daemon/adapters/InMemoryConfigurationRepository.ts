import { Effect } from "effect";
import type {
  ConfigurationChange,
  ConfigurationFieldStatus,
  ConfigurationMaintenancePlan,
  ConfigurationStatus,
  ConfigurationValue,
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

const defaultsFor = (target: ConfigurationTarget): Map<string, ConfigurationValue> =>
  target.scope === "daemon"
    ? new Map<string, ConfigurationValue>([
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
      ])
    : new Map<string, ConfigurationValue>([
        ["limits.executingRuns", projectConfigurationDefaults.limits.executingRuns],
        ["limits.newStartQueue", projectConfigurationDefaults.limits.newStartQueue],
      ]);

const keyOf = (target: ConfigurationTarget): string =>
  target.scope === "daemon" ? "daemon" : `project:${target.projectId}`;

const failed = (cause: unknown): ConfigurationError =>
  cause instanceof ConfigurationError
    ? cause
    : new ConfigurationError({
        code: "CONFIGURATION_STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

/** In-memory configuration adapter for controlled-clock use-case tests. */
export class InMemoryConfigurationRepository implements ConfigurationRepositoryPort {
  readonly #effective = new Map<string, Map<string, ConfigurationValue>>();
  readonly #pending = new Map<string, Map<string, ConfigurationValue>>();
  readonly #plans = new Map<string, ConfigurationMaintenancePlan>();
  readonly #results = new Map<
    string,
    {
      readonly plan: ConfigurationMaintenancePlan;
      readonly status: ConfigurationStatus;
      readonly collection: RetentionCollectionResult;
    }
  >();
  #version = 1;

  readonly status = (target: ConfigurationTarget) => Effect.sync(() => this.#status(target));

  readonly preview = (target: ConfigurationTarget, changes: ReadonlyArray<ConfigurationChange>) =>
    Effect.sync(() => this.#preview(target, changes));

  readonly apply = (target: ConfigurationTarget, changes: ReadonlyArray<ConfigurationChange>) =>
    Effect.sync(() => {
      this.#apply(target, changes);
      this.#version += 1;
      return this.#status(target);
    });

  readonly savePlan = (plan: ConfigurationMaintenancePlan) =>
    Effect.try({
      try: () => {
        if (plan.expectedStateVersion !== this.#version) {
          throw new ConfigurationError({
            code: "CONFIGURATION_PLAN_STALE",
            message: "configuration changed before the maintenance plan was retained",
          });
        }
        const prior = this.#plans.get(plan.planId);
        if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(plan)) {
          throw new ConfigurationError({
            code: "CONFIGURATION_CONFLICT",
            message: "the maintenance plan ID names different content",
          });
        }
        this.#plans.set(plan.planId, plan);
      },
      catch: failed,
    });

  readonly plan = (planId: string) =>
    Effect.succeed(this.#plans.get(planId) ?? this.#results.get(planId)?.plan);

  readonly confirmPlan = (
    planId: string,
    dataIdentity: string,
    observedAt: string,
    dataState: string,
    collect: () => RetentionCollectionResult,
  ) =>
    Effect.try({
      try: () => {
        const completed = this.#results.get(planId);
        if (completed !== undefined) return completed;
        const plan = this.#plans.get(planId);
        if (plan === undefined) {
          throw new ConfigurationError({
            code: "CONFIGURATION_PLAN_NOT_FOUND",
            message: "the exact pending configuration plan was not found",
          });
        }
        if (Date.parse(observedAt) >= Date.parse(plan.expiresAt)) {
          throw new ConfigurationError({
            code: "CONFIGURATION_PLAN_EXPIRED",
            message: "the configuration maintenance plan expired",
          });
        }
        if (
          plan.dataIdentity !== dataIdentity ||
          plan.expectedStateVersion !== this.#version ||
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
        this.#apply(target, plan.changes);
        this.#version += 1;
        this.#plans.delete(planId);
        const result = { plan, status: this.#status(target), collection };
        this.#results.set(planId, result);
        return result;
      },
      catch: failed,
    });

  #status(target: ConfigurationTarget): ConfigurationStatus {
    const key = keyOf(target);
    const effective = this.#effective.get(key) ?? new Map();
    const pending = this.#pending.get(key) ?? new Map();
    return {
      formatVersion: 1,
      scope: target.scope,
      ...(target.scope === "project" ? { projectId: target.projectId } : {}),
      stateVersion: this.#version,
      restartRequired: pending.size > 0,
      fields: [...defaultsFor(target)].map(([path, defaultValue]) => ({
        path,
        effective: effective.get(path) ?? defaultValue,
        default: defaultValue,
        scope: target.scope,
        activation:
          target.scope === "project"
            ? "immediate"
            : path.startsWith("daemon.")
              ? "lifecycle-restart"
              : path.startsWith("runner.")
                ? "future-attempt"
                : "immediate",
        ...(pending.has(path) ? { pending: pending.get(path) as ConfigurationValue } : {}),
      })),
    };
  }

  #preview(
    target: ConfigurationTarget,
    changes: ReadonlyArray<ConfigurationChange>,
  ): ConfigurationStatus {
    const status = this.#status(target);
    const defaults = defaultsFor(target);
    const selected = new Map<string, ConfigurationChange>(
      changes.map((change) => [change.path, change]),
    );
    const fields: ReadonlyArray<ConfigurationFieldStatus> = status.fields.map((field) => {
      const change = selected.get(field.path);
      if (change === undefined) return field;
      const value = change.reset ? (defaults.get(field.path) as ConfigurationValue) : change.value;
      if (field.activation !== "lifecycle-restart") return { ...field, effective: value };
      const { pending: _pending, ...withoutPending } = field;
      return JSON.stringify(value) === JSON.stringify(field.effective)
        ? withoutPending
        : { ...withoutPending, pending: value };
    });
    return {
      ...status,
      restartRequired: fields.some((field) => field.pending !== undefined),
      fields,
    };
  }

  #apply(target: ConfigurationTarget, changes: ReadonlyArray<ConfigurationChange>): void {
    const key = keyOf(target);
    const effective = new Map(this.#effective.get(key) ?? []);
    const pending = new Map(this.#pending.get(key) ?? []);
    const defaults = defaultsFor(target);
    for (const change of changes) {
      const selected =
        target.scope === "daemon" && change.path.startsWith("daemon.") ? pending : effective;
      const value = change.reset ? (defaults.get(change.path) as ConfigurationValue) : change.value;
      if (selected === pending) {
        const current = effective.get(change.path) ?? defaults.get(change.path);
        if (JSON.stringify(value) === JSON.stringify(current)) selected.delete(change.path);
        else selected.set(change.path, value);
      } else if (change.reset) selected.delete(change.path);
      else selected.set(change.path, value);
    }
    this.#effective.set(key, effective);
    this.#pending.set(key, pending);
  }
}
