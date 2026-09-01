import { Context, Effect } from "effect";

export type RunnerResourceKind = "sandbox" | "worktree" | "agent";

export interface RunnerResourceIdentity {
  readonly leaseId: string;
  readonly kind: RunnerResourceKind;
  readonly acquisitionKey: string;
  readonly detail: Readonly<Record<string, string>>;
}

export interface ResourceLeaseClient {
  readonly beginAcquisition: (resource: RunnerResourceIdentity) => Effect.Effect<void>;
  readonly confirmAcquired: (
    leaseId: string,
    evidence: { readonly providerIdentity: string; readonly locator: string },
  ) => Effect.Effect<void>;
  readonly beginRelease: (leaseId: string) => Effect.Effect<void>;
  readonly confirmReleased: (leaseId: string, evidence: string) => Effect.Effect<void>;
  readonly preserve: (leaseId: string, reason: string) => Effect.Effect<void>;
  readonly unresolved: (leaseId: string, reason: string) => Effect.Effect<void>;
}

/**
 * The Project Runner's private client for Daemon-owned Resource leases.
 *
 * The default keeps the retired single-process CLI compatible. A Daemon Project Runner always
 * replaces it with the durable private-channel adapter before it executes authored work.
 */
export const ResourceLeaseClient = Context.Reference<ResourceLeaseClient>(
  "kojo/project/ResourceLeaseClient",
  {
    defaultValue: () => ({
      beginAcquisition: () => Effect.void,
      confirmAcquired: () => Effect.void,
      beginRelease: () => Effect.void,
      confirmReleased: () => Effect.void,
      preserve: () => Effect.void,
      unresolved: () => Effect.void,
    }),
  },
);
