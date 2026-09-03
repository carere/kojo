import type { AutomaticStart, ProcessState } from "./DaemonStatus.ts";
import type { LifecycleRecordedOwner } from "./LifecycleOperation.ts";

export interface PurgeCorrectnessSummary {
  readonly projects: number;
  readonly runs: number;
  readonly clientRequests: number;
  readonly askings: number;
  readonly artifacts: number;
  readonly recordsByTable: Readonly<Record<string, number>>;
}

export interface PurgeResourceRisk {
  readonly leaseId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly kind: string;
  readonly state: string;
  readonly reason?: string;
}

export interface PurgeOwnedScope {
  readonly relativePath: string;
  readonly kind: "directory" | "file";
  readonly device: number;
  readonly inode: number;
  readonly sha256?: string;
}

/** Safety evidence authored by the sole Daemon owner before it gives up SQLite ownership. */
export interface PurgeSafetyEvidence {
  readonly formatVersion: 1;
  readonly evidenceId: string;
  readonly operationId: string;
  readonly dataIdentity: string;
  readonly stateVersion: string;
  readonly correctnessFingerprint: string;
  readonly correctness: PurgeCorrectnessSummary;
  readonly resourceRisks: ReadonlyArray<PurgeResourceRisk>;
  readonly ownedScope: ReadonlyArray<PurgeOwnedScope>;
  readonly owner: LifecycleRecordedOwner;
  readonly ownerProcessState: {
    readonly daemon: "sole-owner-finalizing";
    readonly runners: "stopped";
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly seal: string;
}

export interface PurgePlan {
  readonly formatVersion: 1;
  readonly planId: string;
  readonly kind: "purge";
  readonly dataIdentity: string;
  readonly requestHash: string;
  readonly affectedScope: ReadonlyArray<string>;
  readonly expectedStateVersion: string;
  readonly expectedCorrectnessFingerprint: string;
  readonly evidenceId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly correctness: PurgeCorrectnessSummary;
  readonly resourceRisks: ReadonlyArray<PurgeResourceRisk>;
  readonly observed: {
    readonly automaticStart: AutomaticStart;
    readonly process: ProcessState;
  };
}

export interface PurgeResult {
  readonly outcome: "purged";
  readonly operationId: string;
  readonly dataIdentity: string;
  readonly completedAt: string;
}

/** Exact maintenance plan for one restricted safety-evidence recovery. */
export interface PurgeSafetyRecoveryPlan {
  readonly formatVersion: 1;
  readonly kind: "purge-safety-recovery";
  readonly planId: string;
  readonly dataIdentity: string;
  readonly lifecycleOperationId?: string;
  readonly sourceReleaseId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly expected: {
    readonly automaticStart: "disabled";
    readonly process: "stopped";
  };
}

export interface PurgeSafetyRecoveryCheck {
  readonly plan: PurgeSafetyRecoveryPlan;
  readonly planToken: string;
}

export interface PurgeSafetyRecoveryResult {
  readonly outcome: "recovered";
  readonly dataIdentity: string;
  readonly evidenceId: string;
  readonly lifecycleOperationId: string;
}
