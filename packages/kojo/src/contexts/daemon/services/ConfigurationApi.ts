import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import type {
  ConfigurationApplyResult,
  ConfigurationCheck,
  ConfigurationMaintenancePlan,
  ConfigurationStatus,
  DaemonConfiguration,
  RetentionCollectionResult,
  RetentionDuration,
} from "../models/Configuration.ts";
import { ConfigurationError } from "../models/ConfigurationError.ts";
import type {
  ConfigurationRepositoryPort,
  ConfigurationTarget,
} from "../ports/ConfigurationRepository.ts";
import type { RetentionRepositoryPort } from "../ports/RetentionRepository.ts";
import { configurationRequestHash, decodeConfigurationPatch } from "./configurationPatch.ts";

const emptyCollection: RetentionCollectionResult = { runs: [], traces: [], artifacts: [] };

const retentionFrom = (status: ConfigurationStatus): DaemonConfiguration["retention"] => {
  const value = (path: string): RetentionDuration => {
    const field = status.fields.find((candidate) => candidate.path === path);
    if (field?.effective === "indefinite" || typeof field?.effective === "number") {
      return field.effective;
    }
    throw new ConfigurationError({
      code: "CONFIGURATION_STORE_FAILED",
      message: `configuration status has no valid ${path}`,
    });
  };
  return {
    runHistoryMs: value("retention.runHistoryMs"),
    traceMs: value("retention.traceMs"),
    artifactMs: value("retention.artifactMs"),
  };
};

const shorter = (prior: RetentionDuration, proposed: RetentionDuration): boolean =>
  proposed !== "indefinite" && (prior === "indefinite" || proposed < prior);

const targetName = (target: ConfigurationTarget): "daemon" | `project:${string}` =>
  target.scope === "daemon" ? "daemon" : `project:${target.projectId}`;

/** Operator configuration use case. Validation completes before any durable change. */
export class ConfigurationApi {
  readonly #dataIdentity: string;
  readonly #now: () => number;
  readonly #configuration: ConfigurationRepositoryPort;
  readonly #retention: RetentionRepositoryPort;

  constructor(options: {
    readonly dataIdentity: string;
    readonly now: () => number;
    readonly configuration: ConfigurationRepositoryPort;
    readonly retention: RetentionRepositoryPort;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#now = options.now;
    this.#configuration = options.configuration;
    this.#retention = options.retention;
  }

  readonly status = (target: ConfigurationTarget) => this.#configuration.status(target);

  readonly check = (
    target: ConfigurationTarget,
    patch: unknown,
    mutation?: MutationEnvelope,
  ): Effect.Effect<ConfigurationCheck, ConfigurationError> => {
    const api = this;
    return Effect.gen(function* () {
      const changes = yield* Effect.try({
        try: () => decodeConfigurationPatch(patch, target.scope),
        catch: (cause) =>
          cause instanceof ConfigurationError
            ? cause
            : new ConfigurationError({
                code: "INVALID_CONFIGURATION_PATCH",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      });
      const current = yield* api.#configuration.status(target);
      const proposed = yield* api.#configuration.preview(target, changes);
      if (target.scope === "project") {
        const result = { formatVersion: 1 as const, proposed };
        if (mutation !== undefined)
          yield* api.#configuration.recordOutcome(mutation, result as unknown as JsonValue);
        return result;
      }
      const before = retentionFrom(current);
      const after = retentionFrom(proposed);
      const shortens =
        shorter(before.runHistoryMs, after.runHistoryMs) ||
        shorter(before.traceMs, after.traceMs) ||
        shorter(before.artifactMs, after.artifactMs);
      if (!shortens) {
        const result = { formatVersion: 1 as const, proposed };
        if (mutation !== undefined)
          yield* api.#configuration.recordOutcome(mutation, result as unknown as JsonValue);
        return result;
      }
      const issuedAt = new Date(api.#now()).toISOString();
      const impact = yield* api.#retention.inspect(after, issuedAt);
      if (
        impact.runIds.length === 0 &&
        impact.traceRunIds.length === 0 &&
        impact.artifactIds.length === 0
      ) {
        const result = { formatVersion: 1 as const, proposed };
        if (mutation !== undefined)
          yield* api.#configuration.recordOutcome(mutation, result as unknown as JsonValue);
        return result;
      }
      const plan: ConfigurationMaintenancePlan = {
        formatVersion: 1,
        planId: crypto.getRandomValues(new Uint8Array(32)).toHex(),
        kind: "configuration-retention",
        dataIdentity: api.#dataIdentity,
        requestHash: configurationRequestHash(targetName(target), changes),
        affectedScope: targetName(target),
        expectedStateVersion: current.stateVersion,
        expectedDataState: impact.stateFingerprint,
        issuedAt,
        expiresAt: new Date(api.#now() + 10 * 60_000).toISOString(),
        changes,
        impact,
      };
      const result = { formatVersion: 1 as const, proposed, plan };
      if (mutation === undefined) yield* api.#configuration.savePlan(plan);
      else
        yield* api.#configuration.savePlan(plan, {
          mutation,
          result: result as unknown as JsonValue,
        });
      return result;
    });
  };

  readonly apply = (
    target: ConfigurationTarget,
    patch: unknown,
    mutation?: MutationEnvelope,
  ): Effect.Effect<ConfigurationApplyResult, ConfigurationError> => {
    const api = this;
    return Effect.gen(function* () {
      const checked = yield* api.check(target, patch);
      if (checked.plan !== undefined) {
        return yield* new ConfigurationError({
          code: "CONFIGURATION_PLAN_REQUIRED",
          message: `retention can delete retained data; confirm exact plan ${checked.plan.planId}`,
        });
      }
      const changes = yield* Effect.try({
        try: () => decodeConfigurationPatch(patch, target.scope),
        catch: (cause) =>
          cause instanceof ConfigurationError
            ? cause
            : new ConfigurationError({
                code: "INVALID_CONFIGURATION_PATCH",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      });
      const status = yield* api.#configuration.apply(
        target,
        changes,
        ...(mutation === undefined ? [] : ([mutation] as const)),
      );
      return { formatVersion: 1, status, collection: emptyCollection };
    });
  };

  readonly confirm = (
    planId: string,
    mutation?: MutationEnvelope,
  ): Effect.Effect<ConfigurationApplyResult, ConfigurationError> => {
    const api = this;
    return Effect.gen(function* () {
      const plan = yield* api.#configuration.plan(planId);
      if (plan === undefined) {
        return yield* new ConfigurationError({
          code: "CONFIGURATION_PLAN_NOT_FOUND",
          message: "the exact pending configuration plan was not found",
        });
      }
      const observedAt = new Date(api.#now()).toISOString();
      const target: ConfigurationTarget = plan.affectedScope.startsWith("project:")
        ? { scope: "project", projectId: plan.affectedScope.slice("project:".length) }
        : { scope: "daemon" };
      const proposed = yield* api.#configuration.preview(target, plan.changes);
      const retention = retentionFrom(proposed);
      const currentImpact = yield* api.#retention.inspect(retention, observedAt);
      const collectNow = api.#retention.collectNow;
      const confirmed = yield* api.#configuration.confirmPlan(
        planId,
        api.#dataIdentity,
        observedAt,
        currentImpact.stateFingerprint,
        () => collectNow(plan.impact, retention, observedAt),
        ...(mutation === undefined ? [] : ([mutation] as const)),
      );
      api.#retention.finishFileCleanup?.();
      return { formatVersion: 1, status: confirmed.status, collection: confirmed.collection };
    });
  };
}
