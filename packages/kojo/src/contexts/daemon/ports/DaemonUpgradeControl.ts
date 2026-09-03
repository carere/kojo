import type { Effect } from "effect";
import type { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleDrainProgress,
  LifecycleRecordedOwner,
  UpgradeBackupEvidence,
  UpgradeReadinessEvidence,
} from "../models/LifecycleOperation.ts";
import type {
  UpgradeFinalPreflight,
  UpgradeHandoff,
  UpgradeRollbackSafety,
} from "../models/UpgradeActivation.ts";

/** The Daemon-owned database and execution half of managed upgrade activation. */
export interface DaemonUpgradeControl {
  readonly inspectPreflight: (
    operationId: string,
    dataIdentity: string,
    requestHash: string,
    sourceReleaseId: string,
    candidateReleaseId: string,
    checkedRetainedSetHash: string,
  ) => Effect.Effect<LifecycleRecordedOwner, LifecycleError>;
  readonly beginDrain: (
    operationId: string,
  ) => Effect.Effect<LifecycleDrainProgress, LifecycleError>;
  readonly readDrain: (
    operationId: string,
  ) => Effect.Effect<LifecycleDrainProgress, LifecycleError>;
  readonly forceDrain: (
    operationId: string,
    cleanupMillis: number,
    forceAuthorizationId: string,
  ) => Effect.Effect<LifecycleDrainProgress, LifecycleError>;
  readonly holdMutations: (operationId: string) => Effect.Effect<void, LifecycleError>;
  readonly repeatFinalPreflight: (
    operationId: string,
    candidateReleaseId: string,
    checkedRetainedSetHash: string,
  ) => Effect.Effect<UpgradeFinalPreflight, LifecycleError>;
  readonly releaseUpgradeHolds: (operationId: string) => Effect.Effect<void, LifecycleError>;
  readonly prepareHandoff: (operationId: string) => Effect.Effect<UpgradeHandoff, LifecycleError>;
  readonly confirmControllerReady: (
    operationId: string,
    handoffDigest: string,
  ) => Effect.Effect<void, LifecycleError>;
  readonly createVerifiedBackup: (
    operationId: string,
  ) => Effect.Effect<UpgradeBackupEvidence, LifecycleError>;
  readonly stopOwnedProcesses: (
    operationId: string,
    cleanupMillis: number,
    forceAuthorizationId?: string,
  ) => Effect.Effect<LifecycleRecordedOwner, LifecycleError>;
  readonly readCandidateReadiness: (
    operationId: string,
    priorDaemonInstanceId: string,
  ) => Effect.Effect<UpgradeReadinessEvidence, LifecycleError>;
  readonly authorizeActivation: (
    operationId: string,
    readiness: UpgradeReadinessEvidence,
  ) => Effect.Effect<LifecycleRecordedOwner, LifecycleError>;
  readonly inspectRollbackSafety: (
    operationId: string,
    sourceReleaseId: string,
  ) => Effect.Effect<UpgradeRollbackSafety, LifecycleError>;
  readonly readRollbackReadiness: (
    operationId: string,
  ) => Effect.Effect<UpgradeReadinessEvidence, LifecycleError>;
  readonly authorizeRollback: (
    operationId: string,
    readiness: UpgradeReadinessEvidence,
  ) => Effect.Effect<LifecycleRecordedOwner, LifecycleError>;
}
