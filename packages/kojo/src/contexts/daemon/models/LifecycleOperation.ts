import type { ManagerState, ProcessState } from "./DaemonStatus.ts";

export type LifecycleOperationKind = "stop" | "restart" | "enable" | "disable" | "disable-now";

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
  | "completed"
  | "repair-required";

export type LifecycleOutcome = "in-progress" | "succeeded" | "repair-required";

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
  readonly stage: LifecycleStage;
  readonly stageRevision: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly compatibility: "not-applicable";
  readonly rollbackAttempted: false;
  readonly drain?: LifecycleDrainProgress;
  readonly recordedOwner?: LifecycleRecordedOwner;
  readonly handoffDigest?: string;
  readonly controllerAcceptedAt?: string;
  readonly forceAuthorizationId?: string;
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
  "handoff-prepared": 3,
  "controller-ready": 4,
  "controller-accepted": 5,
  "cleanup-started": 6,
  "owned-processes-stopped": 7,
  "process-stopped": 8,
  "replacement-started": 9,
  completed: 10,
  "repair-required": 10,
};

export const lifecycleOperationKinds: ReadonlyArray<LifecycleOperationKind> = [
  "stop",
  "restart",
  "enable",
  "disable",
  "disable-now",
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
  "completed",
  "repair-required",
];
