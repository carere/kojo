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
  /** Daemon-owned identity committed with the acquisition intent and passed to the provider. */
  readonly providerIdentity: string;
  /** Daemon-owned file that the provider boundary updates and recovery inspects by exact key. */
  readonly inspectionLocator: string;
  readonly providerLocator?: string;
  readonly locator?: string;
  readonly acquiredAt?: string;
  readonly releaseRequestedAt?: string;
  readonly releasedAt?: string;
  readonly observedAt?: string;
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

/** Authority available only after #79 confirms the old Runner process group stopped. */
export interface ResourceRecoveryAuthority {
  readonly projectId: string;
  readonly priorRunnerInstanceId: string;
  readonly terminationConfirmedAt: string;
}

/** One inspection result. Recovery can change state and evidence, never acquisition content. */
export interface ResourceRecoveryObservation {
  readonly leaseId: string;
  readonly outcome: "preserved" | "released" | "unresolved";
  readonly reason: string;
}
