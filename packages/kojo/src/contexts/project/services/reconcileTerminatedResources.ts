import type { ResourceLease, ResourceRecoveryObservation } from "../models/ResourceLease.ts";

export const RESOURCE_RECOVERY_LIMIT = 256;

export type RecoveryWorktreeDisposition = "absent" | "clean" | "dirty" | "unreadable";

export interface ProviderInspection {
  readonly state: "creating" | "acquired" | "release-intent" | "released";
  readonly locator?: string;
}

/**
 * Turn bounded inspection into recovery decisions after #79 confirms process-group termination.
 *
 * This function does not delete or close a Resource. An existing worktree is always preserved,
 * including a clean one, because the failed Runner cannot confirm that provider cleanup finished.
 */
export const terminatedResourceObservations = (
  leases: ReadonlyArray<ResourceLease>,
  inspectProvider: (lease: ResourceLease) => ProviderInspection | undefined,
  inspectWorktree: (locator: string) => RecoveryWorktreeDisposition,
): ReadonlyArray<ResourceRecoveryObservation> =>
  leases.map((lease) => {
    const provider = inspectProvider(lease);
    if (provider === undefined) {
      return {
        leaseId: lease.leaseId,
        outcome: "unresolved" as const,
        reason:
          "the exact acquisition-key provider inspection was absent or did not match durable identity",
      };
    }
    if (provider.state === "released") {
      return {
        leaseId: lease.leaseId,
        outcome: "released" as const,
        reason: "the exact acquisition-key provider registry confirms release",
      };
    }
    const locator = provider.locator ?? lease.locator;
    if (lease.kind !== "worktree" || locator === undefined) {
      return {
        leaseId: lease.leaseId,
        outcome: "unresolved" as const,
        reason:
          "the old Runner process group stopped, but process exit does not confirm provider cleanup",
      };
    }
    const disposition = inspectWorktree(locator);
    if (disposition === "absent") {
      return {
        leaseId: lease.leaseId,
        outcome: "released" as const,
        reason: "bounded host inspection confirmed that the disposable worktree is absent",
      };
    }
    return {
      leaseId: lease.leaseId,
      outcome: "preserved" as const,
      reason: `bounded host inspection found the ${disposition} worktree; Kojo did not delete it`,
    };
  });
