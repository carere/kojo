import type { CommittedResourceIdentity } from "../ports/ResourceLeaseClient.ts";

export type ProviderResourceState = "creating" | "acquired" | "release-intent" | "released";

export interface ProviderResourceEvidence {
  readonly state: ProviderResourceState;
  readonly locator?: string | undefined;
}

/** Build the replay-stable Resource lease identity from its acquisition key. */
export const resourceLeaseId = (acquisitionKey: string): string =>
  `resource_${new Bun.CryptoHasher("sha256").update(acquisitionKey).digest("hex")}`;

/** Build the exact provider environment from committed Daemon Resource identity. */
export const providerResourceEnvironment = (
  identity: CommittedResourceIdentity,
): Record<string, string> => ({
  KOJO_RESOURCE_ACQUISITION_KEY: identity.acquisitionKey,
  KOJO_RESOURCE_PROVIDER_IDENTITY: identity.providerIdentity,
  KOJO_RESOURCE_INSPECTION_FILE: identity.inspectionLocator,
});
