import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Context, type Effect } from "effect";
import type {
  CancellationRequestResult,
  ClaimedRun,
  DaemonRun,
  ForcedStopResult,
  PhaseResult,
  ReservedRun,
  RunAuthority,
  RunExecutionFault,
} from "../models/DaemonRun.ts";
import type { RunStoreError } from "../models/RunStoreError.ts";

export interface AdmitRunRequest {
  readonly dataIdentity: string;
  readonly requestId: string;
  readonly canonicalRequest: string;
  readonly projectId: string;
  readonly workflowName: string;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly admittedAt: string;
}

export interface Admission {
  readonly run: DaemonRun;
  readonly duplicate: boolean;
}

export class RunRepository extends Context.Service<
  RunRepository,
  {
    readonly admit: (request: AdmitRunRequest) => Effect.Effect<Admission, RunStoreError>;
    readonly claim: (
      runId: string,
      runnerInstanceId: string,
      claimedAt: string,
    ) => Effect.Effect<RunAuthority, RunStoreError>;
    readonly claimNext: (
      runnerInstanceId: string,
      claimedAt: string,
    ) => Effect.Effect<ClaimedRun | undefined, RunStoreError>;
    readonly reserveNext: (
      reservationId: string,
      reservedAt: string,
    ) => Effect.Effect<ReservedRun | undefined, RunStoreError>;
    readonly claimReserved: (
      reservationId: string,
      runnerInstanceId: string,
      claimedAt: string,
    ) => Effect.Effect<RunAuthority, RunStoreError>;
    readonly holdReserved: (
      reservationId: string,
      fault: RunExecutionFault,
      heldAt: string,
    ) => Effect.Effect<void, RunStoreError>;
    readonly suspend: (
      authority: RunAuthority,
      suspendedAt: string,
    ) => Effect.Effect<void, RunStoreError>;
    readonly hold: (
      authority: RunAuthority,
      fault: RunExecutionFault,
      heldAt: string,
    ) => Effect.Effect<void, RunStoreError>;
    readonly continueRun: (runId: string, queuedAt: string) => Effect.Effect<void, RunStoreError>;
    readonly read: (runId: string) => Effect.Effect<DaemonRun | undefined, RunStoreError>;
    readonly list: Effect.Effect<ReadonlyArray<DaemonRun>, RunStoreError>;
    readonly readResult: (
      authority: RunAuthority,
      phasePath: string,
      attempt: number,
    ) => Effect.Effect<JsonValue | undefined, RunStoreError>;
    readonly completePhase: (
      authority: RunAuthority,
      phase: PhaseResult,
    ) => Effect.Effect<void, RunStoreError>;
    readonly completeRun: (
      authority: RunAuthority,
      state: "succeeded" | "failed",
      finishedAt: string,
    ) => Effect.Effect<void, RunStoreError>;
    readonly requestCancellation: (
      runId: string,
      requestId: string,
      requestedAt: string,
    ) => Effect.Effect<CancellationRequestResult, RunStoreError>;
    readonly forceStopWorkflow: (request: {
      readonly dataIdentity: string;
      readonly requestId: string;
      readonly canonicalRequest: string;
      readonly projectId: string;
      readonly workflowName: string;
      readonly acceptedAt: string;
    }) => Effect.Effect<ForcedStopResult, RunStoreError>;
    readonly confirmProjectRunnerStopped: (
      projectId: string,
      targetRunIds: ReadonlyArray<string>,
      stoppedAt: string,
      cleanup: { readonly state: "confirmed" | "fault"; readonly detail?: string },
    ) => Effect.Effect<void, RunStoreError>;
    readonly phases: (runId: string) => Effect.Effect<ReadonlyArray<PhaseResult>, RunStoreError>;
  }
>()("kojo/workflow/RunRepository") {}
