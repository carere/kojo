/** A resource that one Project Runner can create while it drives a Run. */
export type ResourceKind = "sandbox" | "worktree" | "agent";

/**
 * The durable lifecycle of one execution Resource.
 *
 * These states are correctness data. They do not come from Trace and a process exit does not move
 * a Resource to `released`.
 */
export type ResourceLeaseState =
  | "acquisition-intent"
  | "acquired"
  | "release-intent"
  | "released"
  | "preserved"
  | "unresolved";

export interface ResourceAcquisitionIntent {
  readonly leaseId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly runnerInstanceId: string;
  readonly claimGeneration: number;
  readonly kind: ResourceKind;
  readonly acquisitionKey: string;
  readonly requestedAt: string;
  readonly detail: Readonly<Record<string, string>>;
}

export interface ResourceLease extends ResourceAcquisitionIntent {
  readonly state: ResourceLeaseState;
  readonly providerIdentity?: string;
  readonly locator?: string;
  readonly acquiredAt?: string;
  readonly releaseRequestedAt?: string;
  readonly releasedAt?: string;
  readonly evidence?: string;
  readonly reason?: string;
}

export interface ResourceLeaseAuthority {
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly runnerInstanceId: string;
  readonly claimGeneration: number;
}
