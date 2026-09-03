import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { BootstrapResponse } from "@carere/kojo-client-contracts/contexts/client/contracts/bootstrap";
import { RUNNER_PROTOCOL_VERSION } from "@carere/kojo-runner-contracts/contexts/project/contracts/frame";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, string>>;
}

interface RuntimeManifest {
  readonly manifestVersion: number;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly runner: string;
  readonly validator: string;
  readonly runnerProtocols: ReadonlyArray<number>;
  readonly requiredFeatures: ReadonlyArray<string>;
  readonly effectPeer: string;
  readonly bun: { readonly minimum: string };
  readonly hosts: ReadonlyArray<string>;
}

interface ManagedReleaseMetadata {
  readonly formatVersion: number;
  readonly compatibility: {
    readonly dataFormats: ReadonlyArray<number>;
    readonly revisionFormats: ReadonlyArray<number>;
    readonly runnerProtocols: ReadonlyArray<number>;
    readonly requiredFeatures: ReadonlyArray<string>;
  };
  readonly migration?: unknown;
}

const repository = resolve(import.meta.dir, "../../../..");
const effectVersion = "4.0.0-beta.106";
const bootstrapVersion: BootstrapResponse["bootstrapVersion"] = 1;

const readJson = <A>(path: string): A =>
  JSON.parse(readFileSync(resolve(repository, path), "utf8")) as A;

const packages = {
  client: "packages/kojo-client-contracts",
  global: "packages/kojo",
  runner: "packages/kojo-runner-contracts",
  runtime: "packages/kojo-runtime",
} as const;

const manifests = Object.fromEntries(
  Object.entries(packages).map(([key, path]) => [
    key,
    readJson<PackageManifest>(`${path}/package.json`),
  ]),
) as Record<keyof typeof packages, PackageManifest>;

const fail = (reason: string): never => {
  throw new Error(`package graph is invalid: ${reason}`);
};

const kojoDependencies = (manifest: PackageManifest): ReadonlyArray<string> =>
  Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@carere/kojo"));

const sameMembers = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean =>
  actual.length === expected.length && expected.every((member) => actual.includes(member));

if (!sameMembers(kojoDependencies(manifests.client), [])) {
  fail("client contracts depend on a Kojo package");
}
if (!sameMembers(kojoDependencies(manifests.runner), [])) {
  fail("Runner contracts depend on a Kojo package");
}
if (
  !sameMembers(kojoDependencies(manifests.global), [
    "@carere/kojo-client-contracts",
    "@carere/kojo-runner-contracts",
  ])
) {
  fail("global Kojo must depend on both contract packages only");
}
if (!sameMembers(kojoDependencies(manifests.runtime), ["@carere/kojo-runner-contracts"])) {
  fail("the runtime must depend on Runner contracts only");
}

for (const contract of [manifests.client, manifests.runner]) {
  const dependencies = {
    ...contract.dependencies,
    ...contract.devDependencies,
    ...contract.peerDependencies,
  };
  if ("effect" in dependencies || "@effect/platform-bun" in dependencies) {
    fail(`${contract.name} has a live Effect dependency`);
  }
}

if (manifests.runtime.peerDependencies?.effect !== effectVersion) {
  fail("the runtime Effect peer is not exact");
}

for (const [key, packagePath] of Object.entries(packages)) {
  const manifest = manifests[key as keyof typeof manifests];
  const exportMap = manifest.exports ?? {};
  if (Object.keys(exportMap).some((name) => name.includes("*"))) {
    fail(`${manifest.name} has a wildcard export`);
  }

  const packageRoot = resolve(repository, packagePath);
  for (const target of Object.values(exportMap)) {
    const exported = resolve(packageRoot, target);
    if (relative(packageRoot, exported).startsWith("..")) {
      fail(`${manifest.name} exports outside its package`);
    }
    if (!existsSync(exported)) {
      fail(`${manifest.name} exports missing file ${target}`);
    }
  }
}

const consoleManifest = readJson<PackageManifest>("apps/console/package.json");
if (
  !sameMembers(kojoDependencies(consoleManifest), ["@carere/kojo-client-contracts"]) ||
  "@carere/kojo" in (consoleManifest.dependencies ?? {})
) {
  fail("the Console dependency direction is invalid");
}

const runtime = readJson<RuntimeManifest>("packages/kojo-runtime/runtime-manifest.json");
if (
  runtime.manifestVersion !== 1 ||
  bootstrapVersion !== 1 ||
  runtime.packageName !== manifests.runtime.name ||
  runtime.packageVersion !== manifests.runtime.version ||
  runtime.effectPeer !== effectVersion ||
  runtime.bun.minimum !== "1.3.14" ||
  !sameMembers(runtime.hosts, ["darwin", "linux"]) ||
  !sameMembers(runtime.runnerProtocols.map(String), [String(RUNNER_PROTOCOL_VERSION)]) ||
  runtime.requiredFeatures.length !== 0
) {
  fail("runtime-manifest.json drifted from the static contract");
}

const managedRelease = readJson<ManagedReleaseMetadata>("packages/kojo/managed-release.json");
if (
  managedRelease.formatVersion !== 1 ||
  !sameMembers(managedRelease.compatibility.dataFormats.map(String), ["1"]) ||
  !sameMembers(managedRelease.compatibility.revisionFormats.map(String), ["1"]) ||
  !sameMembers(managedRelease.compatibility.runnerProtocols.map(String), [
    String(RUNNER_PROTOCOL_VERSION),
  ]) ||
  managedRelease.compatibility.requiredFeatures.length !== 0 ||
  managedRelease.migration !== undefined
) {
  fail("managed-release.json drifted from the current Daemon and Runner contracts");
}
for (const entry of [runtime.runner, runtime.validator]) {
  const packageRoot = resolve(repository, packages.runtime);
  const target = resolve(packageRoot, entry);
  const fromPackage = relative(packageRoot, target);
  if (fromPackage.startsWith("..") || isAbsolute(fromPackage) || !existsSync(target)) {
    fail(`runtime entry is outside the package or missing: ${entry}`);
  }
}

const rootTypeScript = readFileSync(resolve(repository, "tsconfig.json"), "utf8");
const rootMoon = readFileSync(resolve(repository, "moon.yml"), "utf8");
for (const packagePath of Object.values(packages)) {
  if (!rootTypeScript.includes(`./${packagePath}`)) {
    fail(`${packagePath} is absent from TypeScript references`);
  }
}
for (const project of ["kojo", "kojo-client-contracts", "kojo-runner-contracts", "kojo-runtime"]) {
  if (!rootMoon.includes(`  - ${project}`)) {
    fail(`${project} is absent from the Moon root graph`);
  }
}

console.log("package graph and explicit package outputs are valid");
