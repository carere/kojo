import { Effect, Layer } from "effect";
import type {
  ResourceAcquisitionIntent,
  ResourceLease,
  ResourceLeaseAuthority,
  ResourceLeaseState,
  ResourceRecoveryAuthority,
  ResourceRecoveryObservation,
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
  const terminationProofs = new Map<string, string>();
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
    validate?: (lease: ResourceLease) => void,
  ): ResourceLease => {
    const lease = selected(authority, leaseId);
    validate?.(lease);
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
    beginAcquisition: (
      intent: ResourceAcquisitionIntent,
      allocation: {
        readonly providerIdentity: string;
        readonly inspectionLocator: string;
        readonly providerLocator?: string;
      },
    ) =>
      attempt(() => {
        const prior = leases.get(intent.leaseId);
        if (prior !== undefined) {
          const sameIntent =
            prior.projectId === intent.projectId &&
            prior.runId === intent.runId &&
            prior.revisionId === intent.revisionId &&
            prior.runnerInstanceId === intent.runnerInstanceId &&
            prior.claimGeneration === intent.claimGeneration &&
            prior.kind === intent.kind &&
            prior.acquisitionKey === intent.acquisitionKey &&
            prior.requestedAt === intent.requestedAt &&
            JSON.stringify(prior.detail) === JSON.stringify(intent.detail);
          const sameAllocation =
            prior.providerIdentity === allocation.providerIdentity &&
            prior.inspectionLocator === allocation.inspectionLocator &&
            prior.providerLocator === allocation.providerLocator;
          if (!sameIntent || !sameAllocation) {
            throw new ResourceStoreError({
              code: "RESOURCE_STATE_CONFLICT",
              message: `Resource lease ${intent.leaseId} already names different acquisition content.`,
              cause: undefined,
            });
          }
          return prior;
        }
        const priorAcquisition = [...leases.values()].find(
          (lease) =>
            lease.projectId === intent.projectId &&
            lease.runId === intent.runId &&
            lease.acquisitionKey === intent.acquisitionKey,
        );
        if (priorAcquisition !== undefined) {
          throw new ResourceStoreError({
            code: "RESOURCE_STATE_CONFLICT",
            message: `Acquisition key ${intent.acquisitionKey} already names lease ${priorAcquisition.leaseId}.`,
            cause: undefined,
          });
        }
        const lease: ResourceLease = {
          ...intent,
          state: "acquisition-intent",
          providerIdentity: allocation.providerIdentity,
          inspectionLocator: allocation.inspectionLocator,
          ...(allocation.providerLocator === undefined
            ? {}
            : { providerLocator: allocation.providerLocator }),
        };
        leases.set(intent.leaseId, lease);
        return lease;
      }),
    confirmAcquired: (authority, leaseId, acquiredAt, evidence) =>
      attempt(() => {
        if (selected(authority, leaseId).providerIdentity !== evidence.providerIdentity) {
          throw new ResourceStoreError({
            code: "RESOURCE_STATE_CONFLICT",
            message: "The provider did not return the Daemon-owned acquisition identity.",
            cause: undefined,
          });
        }
        return transition(
          authority,
          leaseId,
          ["acquisition-intent"],
          "acquired",
          {
            acquiredAt,
            locator: evidence.locator,
            evidence: "provider returned an acquisition identity",
          },
          (lease) => {
            if (
              lease.state === "acquired" &&
              (lease.acquiredAt !== acquiredAt ||
                lease.providerIdentity !== evidence.providerIdentity ||
                lease.locator !== evidence.locator)
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The acquired Resource retry names different evidence.",
                cause: undefined,
              });
            }
          },
        );
      }),
    beginRelease: (authority, leaseId, releaseRequestedAt) =>
      attempt(() =>
        transition(
          authority,
          leaseId,
          ["acquired"],
          "release-intent",
          {
            releaseRequestedAt,
          },
          (lease) => {
            if (
              lease.state === "release-intent" &&
              lease.releaseRequestedAt !== releaseRequestedAt
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The release intent retry names a different timestamp.",
                cause: undefined,
              });
            }
          },
        ),
      ),
    confirmReleased: (authority, leaseId, releasedAt, evidence) =>
      attempt(() =>
        transition(
          authority,
          leaseId,
          ["release-intent"],
          "released",
          {
            releasedAt,
            evidence,
          },
          (lease) => {
            if (
              lease.state === "released" &&
              (lease.releasedAt !== releasedAt || lease.evidence !== evidence)
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The released Resource retry names different evidence.",
                cause: undefined,
              });
            }
          },
        ),
      ),
    preserve: (authority, leaseId, observedAt, reason) =>
      attempt(() =>
        transition(
          authority,
          leaseId,
          ["acquired", "release-intent"],
          "preserved",
          { observedAt, reason },
          (lease) => {
            if (
              lease.state === "preserved" &&
              (lease.observedAt !== observedAt || lease.reason !== reason)
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The preserved Resource retry names different evidence.",
                cause: undefined,
              });
            }
          },
        ),
      ),
    unresolved: (authority, leaseId, observedAt, reason) =>
      attempt(() =>
        transition(
          authority,
          leaseId,
          ["acquisition-intent", "acquired", "release-intent"],
          "unresolved",
          { observedAt, reason },
          (lease) => {
            if (
              lease.state === "unresolved" &&
              (lease.observedAt !== observedAt || lease.reason !== reason)
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The unresolved Resource retry names different evidence.",
                cause: undefined,
              });
            }
          },
        ),
      ),
    byRun: (runId) =>
      Effect.sync(() => [...leases.values()].filter((lease) => lease.runId === runId)),
    byProject: (projectId) =>
      Effect.sync(() => [...leases.values()].filter((lease) => lease.projectId === projectId)),
    inspectAcquisition: (projectId, runId, acquisitionKey) =>
      Effect.sync(() =>
        [...leases.values()].find(
          (lease) =>
            lease.projectId === projectId &&
            lease.runId === runId &&
            lease.acquisitionKey === acquisitionKey,
        ),
      ),
    confirmRunnerTermination: (authority) =>
      attempt(() => {
        const key = JSON.stringify([authority.projectId, authority.priorRunnerInstanceId]);
        const prior = terminationProofs.get(key);
        if (prior !== undefined && prior !== authority.terminationConfirmedAt) {
          throw new ResourceStoreError({
            code: "RESOURCE_STATE_CONFLICT",
            message: "Project Runner termination proof already has different content.",
            cause: undefined,
          });
        }
        if (prior === undefined) terminationProofs.set(key, authority.terminationConfirmedAt);
      }),
    pendingForTerminatedRunner: (authority: ResourceRecoveryAuthority, limit: number) =>
      attempt(() => {
        if (
          terminationProofs.get(
            JSON.stringify([authority.projectId, authority.priorRunnerInstanceId]),
          ) !== authority.terminationConfirmedAt
        ) {
          throw new ResourceStoreError({
            code: "RESOURCE_AUTHORITY_LOST",
            message: "Resource recovery needs durable termination proof.",
            cause: undefined,
          });
        }
        const pending = [...leases.values()].filter(
          (lease) =>
            lease.projectId === authority.projectId &&
            lease.runnerInstanceId === authority.priorRunnerInstanceId &&
            lease.state !== "released",
        );
        if (pending.length > limit) {
          throw new ResourceStoreError({
            code: "RESOURCE_STATE_CONFLICT",
            message: `Resource recovery exceeded its ${limit} lease bound.`,
            cause: undefined,
          });
        }
        return pending;
      }),
    reconcileTerminatedRunner: (
      authority: ResourceRecoveryAuthority,
      observations: ReadonlyArray<ResourceRecoveryObservation>,
    ) =>
      attempt(() => {
        if (
          terminationProofs.get(
            JSON.stringify([authority.projectId, authority.priorRunnerInstanceId]),
          ) !== authority.terminationConfirmedAt
        ) {
          throw new ResourceStoreError({
            code: "RESOURCE_AUTHORITY_LOST",
            message: "Resource recovery needs durable termination proof.",
            cause: undefined,
          });
        }
        return observations.map((observation) => {
          const lease = leases.get(observation.leaseId);
          if (
            lease === undefined ||
            lease.projectId !== authority.projectId ||
            lease.runnerInstanceId !== authority.priorRunnerInstanceId
          ) {
            throw new ResourceStoreError({
              code: "RESOURCE_AUTHORITY_LOST",
              message: "Resource recovery does not name the terminated Project Runner.",
              cause: undefined,
            });
          }
          if (
            lease.state === "released" ||
            lease.state === "preserved" ||
            lease.state === "unresolved"
          ) {
            return lease;
          }
          const next: ResourceLease = {
            ...lease,
            state: observation.outcome,
            observedAt: authority.terminationConfirmedAt,
            reason: observation.reason,
            ...(observation.outcome === "released"
              ? {
                  releasedAt: authority.terminationConfirmedAt,
                  evidence: observation.reason,
                }
              : {}),
          };
          leases.set(lease.leaseId, next);
          return next;
        });
      }),
  };
});
