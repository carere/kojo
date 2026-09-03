import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { Effect } from "effect";
import type { LifecycleError } from "../models/LifecycleError.ts";
import type {
  NoRollbackPlan,
  UpgradeCheckReport,
  UpgradeCheckResult,
  UpgradeEvidence,
} from "../models/ManagedUpgrade.ts";

export interface IssueNoRollbackPlan {
  readonly dataIdentity: string;
  readonly candidateReleaseId: string;
  readonly requestHash: string;
  readonly affectedScope: ReadonlyArray<string>;
  readonly expectedStateVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly migration: NoRollbackPlan["migration"];
}

/** Daemon-owned evidence and approval persistence for managed release preflight. */
export interface UpgradePreflightRepository {
  readonly capture: (observedAt: string) => Effect.Effect<UpgradeEvidence, LifecycleError>;
  readonly issueNoRollbackPlan: (
    request: IssueNoRollbackPlan,
  ) => Effect.Effect<{ readonly plan: NoRollbackPlan; readonly token?: string }, LifecycleError>;
  readonly approveNoRollbackPlan: (request: {
    readonly token: string;
    readonly dataIdentity: string;
    readonly candidateReleaseId: string;
    readonly expectedStateVersion: string;
    readonly approvedAt: string;
  }) => Effect.Effect<NoRollbackPlan, LifecycleError>;
  readonly record: (
    report: UpgradeCheckReport,
    mutation?: MutationEnvelope,
    result?: UpgradeCheckResult,
  ) => Effect.Effect<void, LifecycleError>;
  readonly latest: Effect.Effect<UpgradeCheckReport | undefined, LifecycleError>;
}
