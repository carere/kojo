import type {
  LifecycleForceAuthorization,
  LifecycleOperation,
  LifecycleOperationKind,
  LifecycleStage,
} from "../models/LifecycleOperation.ts";

export interface BeginLifecycleOperation {
  readonly operationId: string;
  readonly dataIdentity: string;
  readonly originalRequestHash: string;
  readonly kind: LifecycleOperationKind;
  readonly sourceReleaseId: string;
  readonly candidateReleaseId?: string;
  readonly checkedRetainedSetHash?: string;
  readonly startedAt: string;
}

export interface AdvanceLifecycleOperation {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly stage: LifecycleStage;
  readonly updatedAt: string;
  readonly changes?: Partial<
    Pick<
      LifecycleOperation,
      | "drain"
      | "recordedOwner"
      | "handoffDigest"
      | "controllerAcceptedAt"
      | "forceAuthorizationId"
      | "compatibility"
      | "rollbackAttempted"
      | "backup"
      | "migrationCheckpoint"
      | "readiness"
      | "outcome"
      | "detail"
    >
  >;
}

export interface LifecycleJournalRepository {
  readonly begin: (request: BeginLifecycleOperation) => LifecycleOperation;
  readonly read: (operationId: string) => LifecycleOperation | undefined;
  readonly current: () => LifecycleOperation | undefined;
  readonly advance: (request: AdvanceLifecycleOperation) => LifecycleOperation;
  readonly authorizeForce: (request: LifecycleForceAuthorization) => LifecycleOperation;
  readonly controlSecret: (operationId: string) => string;
  readonly forceAuthorizationFor: (operationId: string) => LifecycleForceAuthorization | undefined;
}
