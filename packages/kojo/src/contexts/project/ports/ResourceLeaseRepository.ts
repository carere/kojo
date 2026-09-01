import { Context, type Effect } from "effect";
import type {
  ResourceAcquisitionIntent,
  ResourceLease,
  ResourceLeaseAuthority,
  ResourceRecoveryAuthority,
  ResourceRecoveryObservation,
} from "../models/ResourceLease.ts";
import type { ResourceStoreError } from "../models/ResourceStoreError.ts";

export class ResourceLeaseRepository extends Context.Service<
  ResourceLeaseRepository,
  {
    readonly beginAcquisition: (
      intent: ResourceAcquisitionIntent,
      allocation: {
        readonly providerIdentity: string;
        readonly inspectionLocator: string;
        readonly providerLocator?: string;
      },
    ) => Effect.Effect<ResourceLease, ResourceStoreError>;
    readonly confirmAcquired: (
      authority: ResourceLeaseAuthority,
      leaseId: string,
      acquiredAt: string,
      evidence: { readonly providerIdentity: string; readonly locator: string },
    ) => Effect.Effect<ResourceLease, ResourceStoreError>;
    readonly beginRelease: (
      authority: ResourceLeaseAuthority,
      leaseId: string,
      requestedAt: string,
    ) => Effect.Effect<ResourceLease, ResourceStoreError>;
    readonly confirmReleased: (
      authority: ResourceLeaseAuthority,
      leaseId: string,
      releasedAt: string,
      evidence: string,
    ) => Effect.Effect<ResourceLease, ResourceStoreError>;
    readonly preserve: (
      authority: ResourceLeaseAuthority,
      leaseId: string,
      observedAt: string,
      reason: string,
    ) => Effect.Effect<ResourceLease, ResourceStoreError>;
    readonly unresolved: (
      authority: ResourceLeaseAuthority,
      leaseId: string,
      observedAt: string,
      reason: string,
    ) => Effect.Effect<ResourceLease, ResourceStoreError>;
    readonly byRun: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<ResourceLease>, ResourceStoreError>;
    readonly byProject: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<ResourceLease>, ResourceStoreError>;
    readonly inspectAcquisition: (
      projectId: string,
      runId: string,
      acquisitionKey: string,
    ) => Effect.Effect<ResourceLease | undefined, ResourceStoreError>;
    readonly confirmRunnerTermination: (
      authority: ResourceRecoveryAuthority,
    ) => Effect.Effect<void, ResourceStoreError>;
    readonly pendingForTerminatedRunner: (
      authority: ResourceRecoveryAuthority,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ResourceLease>, ResourceStoreError>;
    readonly reconcileTerminatedRunner: (
      authority: ResourceRecoveryAuthority,
      observations: ReadonlyArray<ResourceRecoveryObservation>,
    ) => Effect.Effect<ReadonlyArray<ResourceLease>, ResourceStoreError>;
  }
>()("kojo/project/ResourceLeaseRepository") {}
