import type { ManagerState, ProcessState } from "./DaemonStatus.ts";

export type LifecycleOperationKind =
  | "stop"
  | "restart"
  | "enable"
  | "disable"
  | "disable-now"
  | "upgrade";

export type LifecycleStage =
  | "prepared"
  | "draining"
  | "drained"
  | "handoff-prepared"
  | "controller-ready"
  | "controller-accepted"
  | "cleanup-started"
  | "owned-processes-stopped"
  | "process-stopped"
  | "replacement-started"
  | "mutations-held"
  | "final-preflight-accepted"
  | "backup-verified"
  | "candidate-selected"
  | "candidate-ready"
  | "activation-authorized"
  | "rollback-selected"
  | "rollback-ready"
  | "upgrade-refused"
  | "activated"
  | "rolled-back"
  | "completed"
  | "repair-required";

export type LifecycleOutcome =
  | "in-progress"
  | "succeeded"
  | "upgrade-refused"
  | "activated"
  | "rolled-back"
  | "repair-required";

export interface UpgradeBackupEvidence {
  readonly backupId: string;
  readonly sha256: string;
  readonly dataVersion: string;
  readonly verifiedAt: string;
}

export interface UpgradeReadinessEvidence {
  readonly daemonInstanceId: string;
  readonly dataIdentity: string;
  readonly sourceReleaseId: string;
  readonly candidateReleaseId: string;
  readonly receiptDigest: string;
  readonly wakeupDigest: string;
  readonly integrity: "ok";
  readonly transports: "ready";
  readonly workflowExecutions: 0;
  readonly checkedAt: string;
}

export interface LifecycleRecordedOwner {
  readonly daemonInstanceId: string;
  readonly runnerInstanceIds: ReadonlyArray<string>;
  readonly recordedAt: string;
}

export interface LifecycleObservedOwner {
  readonly daemonInstanceId?: string;
  readonly manager: ManagerState;
  readonly process: ProcessState;
  readonly observedAt: string;
  readonly detail?: string;
}

export interface LifecycleDrainProgress {
  readonly held: boolean;
  readonly executingRunIds: ReadonlyArray<string>;
  readonly observedAt: string;
}

export interface LifecycleForceAuthorization {
  readonly formatVersion: 1;
  readonly authorizationId: string;
  readonly pendingOperationId: string;
  readonly requestHash: string;
  readonly authorizedAt: string;
}

export interface LifecycleOperation {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly dataIdentity: string;
  readonly originalRequestHash: string;
  readonly kind: LifecycleOperationKind;
  readonly sourceReleaseId: string;
  readonly candidateReleaseId?: string;
  readonly checkedRetainedSetHash?: string;
  readonly stage: LifecycleStage;
  readonly stageRevision: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly compatibility: "not-applicable" | "pending" | "accepted" | "refused";
  readonly rollbackAttempted: boolean;
  readonly drain?: LifecycleDrainProgress;
  readonly recordedOwner?: LifecycleRecordedOwner;
  readonly handoffDigest?: string;
  readonly controllerAcceptedAt?: string;
  readonly forceAuthorizationId?: string;
  readonly backup?: UpgradeBackupEvidence;
  readonly migrationCheckpoint?: string;
  readonly readiness?: UpgradeReadinessEvidence;
  readonly outcome?: Exclude<LifecycleOutcome, "in-progress">;
  readonly detail?: string;
}

export type LifecycleNextAction =
  | "wait-for-drain"
  | "force-pending-operation"
  | "complete-handoff"
  | "stop-native-service"
  | "start-replacement"
  | "inspect-result"
  | "repair"
  | "none";

export interface LifecycleOperationStatus {
  readonly operation: LifecycleOperation;
  readonly outcome: LifecycleOutcome;
  readonly recordedOwner?: LifecycleRecordedOwner;
  readonly observedOwner: LifecycleObservedOwner;
  readonly progress: LifecycleDrainProgress | undefined;
  readonly nextPermittedAction: LifecycleNextAction;
}

export const lifecycleStageOrder: Readonly<Record<LifecycleStage, number>> = {
  prepared: 0,
  draining: 1,
  drained: 2,
  "mutations-held": 3,
  "final-preflight-accepted": 4,
  "handoff-prepared": 5,
  "controller-ready": 6,
  "controller-accepted": 7,
  "backup-verified": 8,
  "cleanup-started": 9,
  "owned-processes-stopped": 10,
  "process-stopped": 11,
  "replacement-started": 12,
  "candidate-selected": 12,
  "candidate-ready": 13,
  "activation-authorized": 14,
  "rollback-selected": 14,
  "rollback-ready": 15,
  "upgrade-refused": 15,
  activated: 16,
  "rolled-back": 16,
  completed: 16,
  "repair-required": 16,
};

export const lifecycleOperationKinds: ReadonlyArray<LifecycleOperationKind> = [
  "stop",
  "restart",
  "enable",
  "disable",
  "disable-now",
  "upgrade",
];

export const lifecycleStages: ReadonlyArray<LifecycleStage> = [
  "prepared",
  "draining",
  "drained",
  "handoff-prepared",
  "controller-ready",
  "controller-accepted",
  "cleanup-started",
  "owned-processes-stopped",
  "process-stopped",
  "replacement-started",
  "mutations-held",
  "final-preflight-accepted",
  "backup-verified",
  "candidate-selected",
  "candidate-ready",
  "activation-authorized",
  "rollback-selected",
  "rollback-ready",
  "upgrade-refused",
  "activated",
  "rolled-back",
  "completed",
  "repair-required",
];
