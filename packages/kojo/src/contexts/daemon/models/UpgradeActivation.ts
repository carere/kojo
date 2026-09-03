import type { LifecycleRecordedOwner } from "./LifecycleOperation.ts";

export interface UpgradeFinalPreflight {
  readonly outcome: "accepted" | "refused";
  readonly retainedSetHash: string;
  readonly owner: LifecycleRecordedOwner;
  readonly detail: string;
}

export interface UpgradeHandoff {
  readonly digest: string;
  readonly owner: LifecycleRecordedOwner;
}

export interface UpgradeRollbackSafety {
  readonly safe: boolean;
  readonly sourceReleaseId: string;
  readonly dataVersion: string;
  readonly executionStopped: boolean;
  readonly detail: string;
}
