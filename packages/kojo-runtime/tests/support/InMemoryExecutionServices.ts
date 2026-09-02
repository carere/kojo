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

/** Provider Resources rooted inside an integration fixture that owns their full lifecycle. */
export const sandboxResourcesAt = (root: string, branch: string) => ({
  sandbox: {
    ...identity("test/sandbox", "sandbox"),
    inspectionLocator: `${root}/.kojo-test-registry/sandbox.json`,
  },
  worktree: {
    ...identity("test/worktree", "worktree"),
    inspectionLocator: `${root}/.kojo-test-registry/worktree.json`,
    providerLocator: `${root}/.kojo-test-anchor/.sandcastle/worktrees/${branch.replaceAll("/", "-")}`,
  },
});

/** In-memory execution ports for use-case tests. No host or Daemon adapter is used. */
export const buildInfoLayer = Layer.succeed(BuildInfo, {
  version: "0.0.0-test",
  commit: "test-revision",
  configDigest: "test-config",
  host: "test-host",
});

const resourceLeaseLayer = (inspectionRoot?: string) =>
  Layer.succeed(ResourceLeaseClient, {
    beginAcquisition: (resource) => {
      const committed = identity(resource.acquisitionKey, resource.kind);
      return Effect.succeed(
        inspectionRoot === undefined
          ? committed
          : {
              ...committed,
              inspectionLocator: `${inspectionRoot}/${encodeURIComponent(resource.acquisitionKey)}.json`,
            },
      );
    },
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

export const layer = withResourceLease(resourceLeaseLayer());

/** In-memory ports whose file-backed inspection evidence stays inside an integration fixture. */
export const layerAt = (root: string) =>
  withResourceLease(resourceLeaseLayer(`${root}/.kojo-test-registry/agent`));
