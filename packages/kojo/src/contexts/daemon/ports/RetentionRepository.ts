import { Context, type Effect } from "effect";
import type {
  DaemonConfiguration,
  RetentionCollectionResult,
  RetentionImpact,
} from "../models/Configuration.ts";
import type { ConfigurationError } from "../models/ConfigurationError.ts";

export interface RetentionRepositoryPort {
  readonly inspect: (
    retention: DaemonConfiguration["retention"],
    observedAt: string,
  ) => Effect.Effect<RetentionImpact, ConfigurationError>;
  readonly collect: (
    impact: RetentionImpact,
    retention: DaemonConfiguration["retention"],
    observedAt: string,
  ) => Effect.Effect<RetentionCollectionResult, ConfigurationError>;
  readonly collectNow: (
    impact: RetentionImpact,
    retention: DaemonConfiguration["retention"],
    observedAt: string,
  ) => RetentionCollectionResult;
  readonly finishFileCleanup?: () => void;
}

export class RetentionRepository extends Context.Service<
  RetentionRepository,
  RetentionRepositoryPort
>()("kojo/daemon/RetentionRepository") {}
