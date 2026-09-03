import { Effect, Layer } from "effect";
import type { CommittedResourceIdentity } from "../../src/contexts/project/ports/ResourceLeaseClient.ts";
import { ResourceLeaseClient } from "../../src/contexts/project/ports/ResourceLeaseClient.ts";
import { BuildInfo } from "../../src/contexts/shared/models/BuildInfo.ts";
import { ArtifactPublisher } from "../../src/contexts/trace/ports/ArtifactPublisher.ts";

const identity = (acquisitionKey: string, kind: string): CommittedResourceIdentity => ({
  acquisitionKey,
  providerIdentity: `in-memory:${kind}:${acquisitionKey}`,
  inspectionLocator: `/in-memory/${kind}/${encodeURIComponent(acquisitionKey)}.json`,
});

/** In-memory execution ports for use-case tests. No host or Daemon adapter is used. */
export const buildInfoLayer = Layer.succeed(BuildInfo, {
  version: "0.0.0-test",
  commit: "test-revision",
  configDigest: "test-config",
  host: "test-host",
});

const resourceLeaseLayer = Layer.succeed(ResourceLeaseClient, {
  beginAcquisition: (resource) => Effect.succeed(identity(resource.acquisitionKey, resource.kind)),
  confirmAcquired: () => Effect.void,
  beginRelease: () => Effect.void,
  confirmReleased: () => Effect.void,
  preserve: () => Effect.void,
  unresolved: () => Effect.void,
});

const withResourceLease = (resourceLease: Layer.Layer<ResourceLeaseClient>) =>
  Layer.mergeAll(
    buildInfoLayer,
    resourceLease,
    Layer.succeed(ArtifactPublisher, {
      publishText: ({ name }) => Effect.succeed({ artifactId: `in-memory:${name}` }),
    }),
  );

export const layer = withResourceLease(resourceLeaseLayer);
