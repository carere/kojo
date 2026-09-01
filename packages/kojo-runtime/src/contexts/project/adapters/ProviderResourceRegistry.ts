import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Data, Effect } from "effect";
import type { CommittedResourceIdentity } from "../ports/ResourceLeaseClient.ts";

export type ProviderResourceState = "creating" | "acquired" | "release-intent" | "released";

export interface ProviderResourceEvidence {
  readonly state: ProviderResourceState;
  readonly locator?: string | undefined;
}

/** A replay-stable Runner protocol identity for one richer acquisition key. */
export const resourceLeaseId = (acquisitionKey: string): string =>
  `resource_${new Bun.CryptoHasher("sha256").update(acquisitionKey).digest("hex")}`;

class ProviderRegistryError extends Data.TaggedError("ProviderRegistryError")<{
  readonly cause: unknown;
}> {}

/** Atomically publish provider-bound inspection evidence in the Daemon-owned registry. */
export const recordProviderState = (
  identity: CommittedResourceIdentity,
  kind: "agent" | "sandbox" | "worktree",
  state: ProviderResourceState,
  locator?: string,
): Effect.Effect<void, ProviderRegistryError> =>
  Effect.tryPromise({
    try: async () => {
      const directory = dirname(identity.inspectionLocator);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const staging = `${identity.inspectionLocator}.${crypto.randomUUID()}.tmp`;
      const contents = `${JSON.stringify({
        registryVersion: 1,
        acquisitionKey: identity.acquisitionKey,
        providerIdentity: identity.providerIdentity,
        kind,
        state,
        ...(locator === undefined ? {} : { locator }),
      })}\n`;
      const staged = await open(staging, "wx", 0o600);
      try {
        await staged.writeFile(contents, "utf8");
        await staged.sync();
      } finally {
        await staged.close();
      }
      await rename(staging, identity.inspectionLocator);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    },
    catch: (cause) => new ProviderRegistryError({ cause }),
  });

/** Read only provider evidence that is bound to the exact committed acquisition identity. */
export const inspectProviderState = (
  identity: CommittedResourceIdentity,
  kind: "agent" | "sandbox" | "worktree",
): Effect.Effect<ProviderResourceEvidence | undefined, ProviderRegistryError> =>
  Effect.tryPromise({
    try: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await readFile(identity.inspectionLocator, "utf8")) as Record<
          string,
          unknown
        >;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      }
      if (
        parsed.registryVersion !== 1 ||
        parsed.acquisitionKey !== identity.acquisitionKey ||
        parsed.providerIdentity !== identity.providerIdentity ||
        parsed.kind !== kind ||
        !["creating", "acquired", "release-intent", "released"].includes(String(parsed.state))
      ) {
        throw new Error("provider inspection evidence does not match the committed Resource");
      }
      return {
        state: parsed.state as ProviderResourceState,
        ...(typeof parsed.locator === "string" ? { locator: parsed.locator } : {}),
      };
    },
    catch: (cause) => new ProviderRegistryError({ cause }),
  });

/** Exact environment received by the actual sandbox or agent provider before it creates work. */
export const providerResourceEnvironment = (
  identity: CommittedResourceIdentity,
): Record<string, string> => ({
  KOJO_RESOURCE_ACQUISITION_KEY: identity.acquisitionKey,
  KOJO_RESOURCE_PROVIDER_IDENTITY: identity.providerIdentity,
  KOJO_RESOURCE_INSPECTION_FILE: identity.inspectionLocator,
});
