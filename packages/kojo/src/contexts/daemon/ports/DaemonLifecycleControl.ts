import type { Effect } from "effect";
import type { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleDrainProgress,
  LifecycleRecordedOwner,
} from "../models/LifecycleOperation.ts";
import type { PurgeSafetyEvidence } from "../models/Purge.ts";

export interface LifecycleHandoff {
  readonly digest: string;
  readonly owner: LifecycleRecordedOwner;
}

/** The narrow Daemon-owned half of one lifecycle handoff. */
export interface DaemonLifecycleControl {
  readonly inspectPreflight: (
    operationId: string,
    dataIdentity: string,
    requestHash: string,
  ) => Effect.Effect<LifecycleRecordedOwner, LifecycleError>;
  readonly beginDrain: (
    operationId: string,
    dataIdentity: string,
    requestHash: string,
  ) => Effect.Effect<LifecycleDrainProgress, LifecycleError>;
  readonly readDrain: (
    operationId: string,
  ) => Effect.Effect<LifecycleDrainProgress, LifecycleError>;
  readonly sealPurgeSafety?: (
    operationId: string,
  ) => Effect.Effect<PurgeSafetyEvidence, LifecycleError>;
  readonly prepareHandoff: (operationId: string) => Effect.Effect<LifecycleHandoff, LifecycleError>;
  readonly confirmControllerReady: (
    operationId: string,
    handoffDigest: string,
  ) => Effect.Effect<void, LifecycleError>;
  readonly stopOwnedProcesses: (
    operationId: string,
    cleanupMillis: number,
    replacementExpected: boolean,
    forceAuthorizationId?: string,
  ) => Effect.Effect<LifecycleRecordedOwner, LifecycleError>;
  readonly confirmReplacementReady: (
    operationId: string,
    priorDaemonInstanceId: string,
  ) => Effect.Effect<LifecycleRecordedOwner, LifecycleError>;
}
