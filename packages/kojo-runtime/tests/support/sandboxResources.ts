import type { CommittedResourceIdentity } from "../../src/contexts/project/ports/ResourceLeaseClient.ts";

const identity = (acquisitionKey: string, kind: string): CommittedResourceIdentity => ({
  acquisitionKey,
  providerIdentity: `test:${kind}:${acquisitionKey}`,
  inspectionLocator: `/test/${kind}/${encodeURIComponent(acquisitionKey)}.json`,
});

/** Committed Provider Resource identities owned by one real adapter fixture. */
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
