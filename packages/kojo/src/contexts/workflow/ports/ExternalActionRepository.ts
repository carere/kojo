import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Context, type Effect } from "effect";
import type { RunAuthority } from "../models/DaemonRun.ts";
import type {
  AuthorizeUncertainRetryRequest,
  ExternalActionDecision,
  ExternalActionEvidence,
  ExternalActionIntent,
  ExternalActionRecoveryPolicy,
} from "../models/ExternalAction.ts";
import type { RunStoreError } from "../models/RunStoreError.ts";

export interface BeginExternalActionRequest {
  readonly authority: RunAuthority;
  readonly actionId: string;
  readonly phasePath: string;
  readonly attempt: number;
  readonly inputHash: string;
  readonly recoveryPolicy: ExternalActionRecoveryPolicy;
  readonly intendedAt: string;
}

export class ExternalActionRepository extends Context.Service<
  ExternalActionRepository,
  {
    readonly begin: (
      request: BeginExternalActionRequest,
    ) => Effect.Effect<ExternalActionDecision, RunStoreError>;
    readonly confirmResult: (
      authority: RunAuthority,
      actionId: string,
      result: JsonValue,
      detail: string,
      confirmedAt: string,
    ) => Effect.Effect<ExternalActionIntent, RunStoreError>;
    readonly recordEvidence: (
      actionId: string,
      evidence: ExternalActionEvidence,
      observedAt: string,
    ) => Effect.Effect<ExternalActionIntent, RunStoreError>;
    readonly holdOpen: (
      runId: string,
      detail: string,
      observedAt: string,
    ) => Effect.Effect<ReadonlyArray<ExternalActionIntent>, RunStoreError>;
    readonly authorizeRetry: (
      request: AuthorizeUncertainRetryRequest,
    ) => Effect.Effect<ExternalActionIntent, RunStoreError>;
    readonly current: (
      runId: string,
    ) => Effect.Effect<ExternalActionIntent | undefined, RunStoreError>;
    readonly list: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<ExternalActionIntent>, RunStoreError>;
  }
>()("kojo/workflow/ExternalActionRepository") {}
