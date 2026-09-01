import { Context, type Effect } from "effect";

export type RunnerResourceKind = "sandbox" | "worktree" | "agent";

export interface RunnerResourceIdentity {
  readonly leaseId: string;
  readonly kind: RunnerResourceKind;
  readonly acquisitionKey: string;
  readonly detail: Readonly<Record<string, string>>;
}

export interface CommittedResourceIdentity {
  readonly acquisitionKey: string;
  readonly providerIdentity: string;
  readonly inspectionLocator: string;
  readonly providerLocator?: string;
}

/**
 * The Project Runner's private client for Daemon-owned Resource leases.
 *
 * Execution has no default. A Project Runner cannot execute authored work without the durable
 * Daemon mutation channel.
 */
export class ResourceLeaseClient extends Context.Service<
  ResourceLeaseClient,
  {
    readonly beginAcquisition: (
      resource: RunnerResourceIdentity,
    ) => Effect.Effect<CommittedResourceIdentity>;
    readonly confirmAcquired: (
      leaseId: string,
      evidence: { readonly providerIdentity: string; readonly locator: string },
    ) => Effect.Effect<void>;
    readonly beginRelease: (leaseId: string) => Effect.Effect<void>;
    readonly confirmReleased: (leaseId: string, evidence: string) => Effect.Effect<void>;
    readonly preserve: (leaseId: string, reason: string) => Effect.Effect<void>;
    readonly unresolved: (leaseId: string, reason: string) => Effect.Effect<void>;
  }
>()("kojo/project/ResourceLeaseClient") {}
