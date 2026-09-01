import { Effect, Layer } from "effect";
import type {
  ResourceAcquisitionIntent,
  ResourceLease,
  ResourceLeaseAuthority,
  ResourceLeaseState,
} from "../models/ResourceLease.ts";
import { ResourceStoreError } from "../models/ResourceStoreError.ts";
import { ResourceLeaseRepository } from "../ports/ResourceLeaseRepository.ts";

const authorityMatches = (lease: ResourceLease, authority: ResourceLeaseAuthority): boolean =>
  lease.projectId === authority.projectId &&
  lease.runId === authority.runId &&
  lease.revisionId === authority.revisionId &&
  lease.runnerInstanceId === authority.runnerInstanceId &&
  lease.claimGeneration === authority.claimGeneration;

/** An inspectable Resource lease adapter for unit tests. */
export const layer = Layer.sync(ResourceLeaseRepository, () => {
  const leases = new Map<string, ResourceLease>();
  const selected = (authority: ResourceLeaseAuthority, leaseId: string): ResourceLease => {
    const lease = leases.get(leaseId);
    if (lease === undefined || !authorityMatches(lease, authority)) {
      throw new ResourceStoreError({
        code: "RESOURCE_AUTHORITY_LOST",
        message: "The Project Runner does not hold this Resource lease authority.",
        cause: undefined,
      });
    }
    return lease;
  };
  const transition = (
    authority: ResourceLeaseAuthority,
    leaseId: string,
    allowed: ReadonlyArray<ResourceLeaseState>,
    state: ResourceLeaseState,
    update: Partial<ResourceLease>,
  ): ResourceLease => {
    const lease = selected(authority, leaseId);
    if (lease.state === state) return lease;
    if (!allowed.includes(lease.state)) {
      throw new ResourceStoreError({
        code: "RESOURCE_STATE_CONFLICT",
        message: `Resource lease ${leaseId} is ${lease.state}, not ${allowed.join(" or ")}.`,
        cause: undefined,
      });
    }
    const next = { ...lease, ...update, state };
    leases.set(leaseId, next);
    return next;
  };
  const attempt = <A>(use: () => A) =>
    Effect.try({ try: use, catch: (cause) => cause as ResourceStoreError });
  return {
    beginAcquisition: (intent: ResourceAcquisitionIntent) =>
      attempt(() => {
        const prior = leases.get(intent.leaseId);
        if (prior !== undefined) return prior;
        const lease: ResourceLease = { ...intent, state: "acquisition-intent" };
        leases.set(intent.leaseId, lease);
        return lease;
      }),
    confirmAcquired: (authority, leaseId, acquiredAt, evidence) =>
      attempt(() =>
        transition(authority, leaseId, ["acquisition-intent"], "acquired", {
          acquiredAt,
          providerIdentity: evidence.providerIdentity,
          locator: evidence.locator,
          evidence: "provider returned an acquisition identity",
        }),
      ),
    beginRelease: (authority, leaseId, releaseRequestedAt) =>
      attempt(() =>
        transition(authority, leaseId, ["acquired"], "release-intent", {
          releaseRequestedAt,
        }),
      ),
    confirmReleased: (authority, leaseId, releasedAt, evidence) =>
      attempt(() =>
        transition(authority, leaseId, ["release-intent"], "released", {
          releasedAt,
          evidence,
        }),
      ),
    preserve: (authority, leaseId, _observedAt, reason) =>
      attempt(() =>
        transition(authority, leaseId, ["acquired", "release-intent"], "preserved", { reason }),
      ),
    unresolved: (authority, leaseId, _observedAt, reason) =>
      attempt(() =>
        transition(
          authority,
          leaseId,
          ["acquisition-intent", "acquired", "release-intent"],
          "unresolved",
          { reason },
        ),
      ),
    byRun: (runId) =>
      Effect.sync(() => [...leases.values()].filter((lease) => lease.runId === runId)),
    byProject: (projectId) =>
      Effect.sync(() => [...leases.values()].filter((lease) => lease.projectId === projectId)),
  };
});
