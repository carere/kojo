import { readFileSync } from "node:fs";
import { releaseTagPlan } from "../../packages/kojo/src/scripts/release/ReleaseTags.ts";
import { assertReleaseStage } from "../../packages/kojo/src/scripts/release/ReleaseVersion.ts";
import type { ReleaseStage } from "../../packages/kojo/src/scripts/release/ReleaseVersion.ts";

interface ReleaseManifest {
  readonly packages: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly stage: ReleaseStage;
  readonly version: string;
}

interface RegistryMetadata {
  readonly "dist-tags"?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<Record<string, unknown>>;
}

const registry = (process.env.KOJO_NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
const token = process.env.NPM_TOKEN;
if (token === undefined || token.length === 0) throw new Error("NPM_TOKEN is not set.");

const manifestPath = Bun.argv[2];
const mode = Bun.argv[3] ?? "activate";
if (manifestPath === undefined || !["activate", "protect-latest"].includes(mode)) {
  throw new Error("Usage: release-tags.ts <release-manifest> [activate|protect-latest]");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
assertReleaseStage(manifest.version, manifest.stage);
const expectedPackages = (
  JSON.parse(
    readFileSync(new URL("../release-packages.json", import.meta.url), "utf8"),
  ) as ReadonlyArray<{ readonly name: string }>
).map(({ name }) => name);
if (
  manifest.packages.length !== expectedPackages.length ||
  manifest.packages.some((releasePackage, index) => releasePackage.name !== expectedPackages[index])
) {
  throw new Error("The Release manifest does not contain the coordinated package set in order.");
}

const escapedPackageName = (name: string): string =>
  name.startsWith("@") ? name.replace("/", "%2f") : encodeURIComponent(name);

const packageEndpoint = (name: string): string =>
  `${registry}/-/package/${escapedPackageName(name)}/dist-tags`;

const metadata = async (name: string): Promise<RegistryMetadata> => {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`Registry lookup for ${name} failed with ${response.status}.`);
  return (await response.json()) as RegistryMetadata;
};

const setTag = async (name: string, tag: string, version: string): Promise<void> => {
  const response = await fetch(`${packageEndpoint(name)}/${encodeURIComponent(tag)}`, {
    body: JSON.stringify(version),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(`Cannot set ${name} tag '${tag}': ${response.status} ${await response.text()}`);
  }
};

const removeTag = async (name: string, tag: string): Promise<void> => {
  const response = await fetch(`${packageEndpoint(name)}/${encodeURIComponent(tag)}`, {
    headers: { authorization: `Bearer ${token}` },
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Cannot remove ${name} tag '${tag}': ${response.status} ${await response.text()}`,
    );
  }
};

const snapshots = new Map<string, Readonly<Record<string, string>>>();
for (const releasePackage of manifest.packages) {
  if (releasePackage.version !== manifest.version) {
    throw new Error(`${releasePackage.name} does not use ${manifest.version}.`);
  }
  const current = await metadata(releasePackage.name);
  if (current.versions?.[manifest.version] === undefined) {
    throw new Error(`${releasePackage.name}@${manifest.version} is not published.`);
  }
  snapshots.set(releasePackage.name, current["dist-tags"] ?? {});
}

const plan =
  mode === "protect-latest"
    ? {
        remove: [],
        removeLatestOnlyWhenItPointsTo: manifest.version,
        set: {},
      }
    : releaseTagPlan(manifest.stage, manifest.version);
const managedTags = new Set([
  ...Object.keys(plan.set),
  ...plan.remove,
  ...(plan.removeLatestOnlyWhenItPointsTo === undefined ? [] : ["latest"]),
]);
const changedPackages: Array<string> = [];

try {
  for (const releasePackage of manifest.packages) {
    const oldTags = snapshots.get(releasePackage.name) ?? {};
    changedPackages.push(releasePackage.name);
    for (const tag of plan.remove) {
      if (oldTags[tag] !== undefined) await removeTag(releasePackage.name, tag);
    }
    if (
      plan.removeLatestOnlyWhenItPointsTo !== undefined &&
      oldTags.latest === plan.removeLatestOnlyWhenItPointsTo
    ) {
      await removeTag(releasePackage.name, "latest");
    }
    for (const [tag, version] of Object.entries(plan.set)) {
      await setTag(releasePackage.name, tag, version);
    }
  }
} catch (error) {
  for (const name of changedPackages.reverse()) {
    const oldTags = snapshots.get(name) ?? {};
    for (const tag of managedTags) {
      if (oldTags[tag] === undefined) await removeTag(name, tag);
      else await setTag(name, tag, oldTags[tag]);
    }
  }
  throw error;
}
