import { Effect } from "effect";
import type {
  DaemonConfiguration,
  RetentionCollectionResult,
  RetentionImpact,
} from "../models/Configuration.ts";
import { ConfigurationError } from "../models/ConfigurationError.ts";
import type { RetentionRepositoryPort } from "../ports/RetentionRepository.ts";

/** Controlled retention state for use-case tests. */
export class InMemoryRetentionRepository implements RetentionRepositoryPort {
  #impact: RetentionImpact;

  constructor(
    impact: RetentionImpact = {
      runIds: [],
      traceRunIds: [],
      artifactIds: [],
      protectedRunIds: [],
      stateFingerprint: "empty",
    },
  ) {
    this.#impact = impact;
  }

  replace(impact: RetentionImpact): void {
    this.#impact = impact;
  }

  readonly inspect = (_retention: DaemonConfiguration["retention"], _observedAt: string) =>
    Effect.succeed(this.#impact);

  readonly collect = (
    planned: RetentionImpact,
    _retention: DaemonConfiguration["retention"],
    _observedAt: string,
  ) =>
    Effect.try({
      try: (): RetentionCollectionResult => {
        if (planned.stateFingerprint !== this.#impact.stateFingerprint) {
          throw new ConfigurationError({
            code: "CONFIGURATION_PLAN_STALE",
            message: "retained state changed before collection",
          });
        }
        return {
          runs: planned.runIds,
          traces: planned.traceRunIds,
          artifacts: planned.artifactIds,
        };
      },
      catch: (cause) =>
        cause instanceof ConfigurationError
          ? cause
          : new ConfigurationError({
              code: "CONFIGURATION_STORE_FAILED",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });

  readonly collectNow = (
    planned: RetentionImpact,
    _retention: DaemonConfiguration["retention"],
    _observedAt: string,
  ): RetentionCollectionResult => {
    if (planned.stateFingerprint !== this.#impact.stateFingerprint) {
      throw new ConfigurationError({
        code: "CONFIGURATION_PLAN_STALE",
        message: "retained state changed before collection",
      });
    }
    return {
      runs: planned.runIds,
      traces: planned.traceRunIds,
      artifacts: planned.artifactIds,
    };
  };
}
