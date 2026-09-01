import type {
  LifecycleRecordedOwner,
  UpgradeBackupEvidence,
  UpgradeReadinessEvidence,
} from "./LifecycleOperation.ts";

export type UpgradeActivationReceiptStage =
  | "prepared"
  | "draining"
  | "mutations-held"
  | "final-preflight-refused"
  | "final-preflight-accepted"
  | "handoff-prepared"
  | "controller-accepted"
  | "backup-verified"
  | "source-execution-stopped"
  | "candidate-ready"
  | "activation-authorized"
  | "rollback-ready"
  | "rolled-back"
  | "upgrade-refused"
  | "repair-required";

export interface UpgradeActivationReceipt {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly dataIdentity: string;
  readonly requestHash: string;
  readonly sourceReleaseId: string;
  readonly candidateReleaseId: string;
  readonly checkedRetainedSetHash: string;
  readonly stage: UpgradeActivationReceiptStage;
  readonly revision: number;
  readonly dispatchHeld: boolean;
  readonly mutationsHeld: boolean;
  readonly owner: LifecycleRecordedOwner;
  readonly finalRetainedSetHash?: string;
  readonly handoffDigest?: string;
  readonly backup?: UpgradeBackupEvidence;
  readonly migrationCheckpoint?: string;
  readonly readiness?: UpgradeReadinessEvidence;
  readonly rollbackAttempted: boolean;
  readonly forceAuthorizationId?: string;
  readonly detail?: string;
}

export const upgradeActivationReceiptStages: ReadonlyArray<UpgradeActivationReceiptStage> = [
  "prepared",
  "draining",
  "mutations-held",
  "final-preflight-refused",
  "final-preflight-accepted",
  "handoff-prepared",
  "controller-accepted",
  "backup-verified",
  "source-execution-stopped",
  "candidate-ready",
  "activation-authorized",
  "rollback-ready",
  "rolled-back",
  "upgrade-refused",
  "repair-required",
];
