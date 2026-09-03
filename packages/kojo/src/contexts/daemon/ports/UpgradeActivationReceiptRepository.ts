import type { Effect } from "effect";
import type { LifecycleError } from "../models/LifecycleError.ts";
import type { LifecycleRecordedOwner } from "../models/LifecycleOperation.ts";
import type {
  UpgradeActivationReceipt,
  UpgradeActivationReceiptStage,
} from "../models/UpgradeActivationReceipt.ts";

export interface PrepareUpgradeActivationReceipt {
  readonly operationId: string;
  readonly dataIdentity: string;
  readonly requestHash: string;
  readonly sourceReleaseId: string;
  readonly candidateReleaseId: string;
  readonly checkedRetainedSetHash: string;
  readonly owner: LifecycleRecordedOwner;
}

export interface AdvanceUpgradeActivationReceipt {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly stage: UpgradeActivationReceiptStage;
  readonly changes?: Partial<
    Pick<
      UpgradeActivationReceipt,
      | "dispatchHeld"
      | "mutationsHeld"
      | "owner"
      | "finalRetainedSetHash"
      | "handoffDigest"
      | "backup"
      | "migrationCheckpoint"
      | "readiness"
      | "rollbackAttempted"
      | "forceAuthorizationId"
      | "detail"
    >
  >;
}

export interface UpgradeActivationReceiptRepository {
  readonly read: (
    operationId: string,
  ) => Effect.Effect<UpgradeActivationReceipt | undefined, LifecycleError>;
  readonly active: Effect.Effect<UpgradeActivationReceipt | undefined, LifecycleError>;
  readonly prepare: (
    request: PrepareUpgradeActivationReceipt,
  ) => Effect.Effect<UpgradeActivationReceipt, LifecycleError>;
  readonly advance: (
    request: AdvanceUpgradeActivationReceipt,
  ) => Effect.Effect<UpgradeActivationReceipt, LifecycleError>;
  readonly checkpointMigration: (
    request: Pick<AdvanceUpgradeActivationReceipt, "operationId" | "expectedRevision">,
    migrate: () => string,
  ) => Effect.Effect<UpgradeActivationReceipt, LifecycleError>;
  readonly activeHold: () => boolean;
}
