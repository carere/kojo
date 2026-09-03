import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Context, type Effect } from "effect";
import type {
  ConfigurationChange,
  ConfigurationMaintenancePlan,
  ConfigurationStatus,
  RetentionCollectionResult,
} from "../models/Configuration.ts";
import type { ConfigurationError } from "../models/ConfigurationError.ts";

export type ConfigurationTarget =
  | { readonly scope: "daemon" }
  | { readonly scope: "project"; readonly projectId: string };

export interface ConfigurationRepositoryPort {
  readonly recordOutcome: (
    mutation: MutationEnvelope,
    result: JsonValue,
  ) => Effect.Effect<void, ConfigurationError>;
  readonly status: (
    target: ConfigurationTarget,
  ) => Effect.Effect<ConfigurationStatus, ConfigurationError>;
  readonly preview: (
    target: ConfigurationTarget,
    changes: ReadonlyArray<ConfigurationChange>,
  ) => Effect.Effect<ConfigurationStatus, ConfigurationError>;
  readonly apply: (
    target: ConfigurationTarget,
    changes: ReadonlyArray<ConfigurationChange>,
    mutation?: MutationEnvelope,
  ) => Effect.Effect<ConfigurationStatus, ConfigurationError>;
  readonly savePlan: (
    plan: ConfigurationMaintenancePlan,
    operation?: { readonly mutation: MutationEnvelope; readonly result: JsonValue },
  ) => Effect.Effect<void, ConfigurationError>;
  readonly plan: (
    planId: string,
  ) => Effect.Effect<ConfigurationMaintenancePlan | undefined, ConfigurationError>;
  readonly confirmPlan: (
    planId: string,
    dataIdentity: string,
    observedAt: string,
    dataState: string,
    collect: () => RetentionCollectionResult,
    mutation?: MutationEnvelope,
  ) => Effect.Effect<
    {
      readonly plan: ConfigurationMaintenancePlan;
      readonly status: ConfigurationStatus;
      readonly collection: RetentionCollectionResult;
    },
    ConfigurationError
  >;
}

export class ConfigurationRepository extends Context.Service<
  ConfigurationRepository,
  ConfigurationRepositoryPort
>()("kojo/daemon/ConfigurationRepository") {}
