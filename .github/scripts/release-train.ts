import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  assertPrereleaseFollowsCandidate,
  assertReleaseStage,
  assertStableFollowsCandidate,
  parseReleaseVersion,
} from "../../packages/kojo/src/scripts/release/ReleaseVersion.ts";
import type { ReleaseStage } from "../../packages/kojo/src/scripts/release/ReleaseVersion.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const registry = (process.env.KOJO_NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");

interface PublicPackage {
  readonly directory: string;
  readonly name: string;
}

const publicPackages = JSON.parse(
  readFileSync(resolve(repositoryRoot, ".github/release-packages.json"), "utf8"),
) as ReadonlyArray<PublicPackage>;

interface PackageJson {
  readonly name: string;
  readonly version: string;
}

interface ManifestPackage {
  readonly archive: string;
  readonly integrity: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
  readonly version: string;
}

interface ReleaseManifest {
  readonly baseVersion: string;
  readonly formatVersion: 1;
  readonly packages: ReadonlyArray<ManifestPackage>;
  readonly runId: string | undefined;
  readonly stage: ReleaseStage;
  readonly testedRevision: string;
  readonly version: string;
}

interface RegistryVersion {
  readonly dist?: { readonly integrity?: string };
}

interface RegistryMetadata {
  readonly "dist-tags"?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<Record<string, RegistryVersion>>;
}

const readJson = <Value>(path: string): Value =>
  JSON.parse(readFileSync(path, "utf8")) as Value;

const packageVersion = (directory: string): string =>
  readJson<PackageJson>(resolve(repositoryRoot, "packages", directory, "package.json")).version;

const assertCoordinatedVersion = (version: string): void => {
  for (const releasePackage of publicPackages) {
    const declared = packageVersion(releasePackage.directory);
    if (declared !== version) {
      throw new Error(
        `${releasePackage.name} declares '${declared}', but the Release train requires '${version}'.`,
      );
    }
  }

  const runtimeManifest = readJson<{ readonly packageVersion: string }>(
    resolve(repositoryRoot, "packages/kojo-runtime/runtime-manifest.json"),
  );
  if (runtimeManifest.packageVersion !== version) {
    throw new Error(
      `runtime-manifest.json declares '${runtimeManifest.packageVersion}', but the Release train requires '${version}'.`,
    );
  }
};

const gitOutput = (arguments_: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync(["git", ...arguments_], { cwd: repositoryRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

const assertCocogittoBump = (version: string): void => {
  const currentRevision = gitOutput(["rev-parse", "HEAD"]).trim();
  const expectedTags = [
    `v${version}`,
    ...publicPackages.map(({ directory }) => `${directory}@v${version}`),
  ];

  for (const tag of expectedTags) {
    const taggedRevision = gitOutput(["rev-list", "-n", "1", tag]).trim();
    if (taggedRevision !== currentRevision) {
      throw new Error(
        `Cocogitto tag '${tag}' points to '${taggedRevision}', not the Release revision '${currentRevision}'.`,
      );
    }
  }
};

const repositoryJsonAt = <Value>(revision: string, path: string): Value =>
  JSON.parse(gitOutput(["show", `${revision}:${path}`])) as Value;

const assertStableSource = (manifestPath: string, currentRevision: string): void => {
  const candidate = readManifest(manifestPath);
  const candidateRelease = assertReleaseStage(candidate.version, "rc");
  assertManifest(candidate, candidate.version, "rc");
  const stableVersion = packageVersion("kojo");
  const stable = assertReleaseStage(stableVersion, "stable");
  if (candidateRelease.baseVersion !== stable.baseVersion) {
    throw new Error("The stable source and accepted RC are from different Release lines.");
  }

  gitOutput(["merge-base", "--is-ancestor", candidate.testedRevision, currentRevision]);
  const changedPaths = gitOutput([
    "diff",
    "--name-only",
    `${candidate.testedRevision}..${currentRevision}`,
  ])
    .trim()
    .split("\n")
    .filter((path) => path.length > 0);
  const allowedFiles = new Set([
    "CHANGELOG.md",
    "bun.lock",
    "packages/kojo-runtime/runtime-manifest.json",
    ...publicPackages.map(({ directory }) => `packages/${directory}/package.json`),
    ...publicPackages.map(({ directory }) => `packages/${directory}/CHANGELOG.md`),
  ]);
  const unexpected = changedPaths.filter(
    (path) => !allowedFiles.has(path) && !/^docs\/release-notes\/[^/]+\.md$/.test(path),
  );
  if (unexpected.length > 0) {
    throw new Error(`Stable has changes outside version files and Release notes: ${unexpected.join(", ")}`);
  }

  for (const releasePackage of publicPackages) {
    const path = `packages/${releasePackage.directory}/package.json`;
    const before = repositoryJsonAt<Record<string, unknown>>(candidate.testedRevision, path);
    const after = readJson<Record<string, unknown>>(resolve(repositoryRoot, path));
    if (before.version !== candidate.version || after.version !== stable.version) {
      throw new Error(`${path} does not have the expected RC and stable versions.`);
    }
    before.version = "<release-version>";
    after.version = "<release-version>";
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`${path} changes more than its version.`);
    }
  }

  const runtimePath = "packages/kojo-runtime/runtime-manifest.json";
  const runtimeBefore = repositoryJsonAt<Record<string, unknown>>(
    candidate.testedRevision,
    runtimePath,
  );
  const runtimeAfter = readJson<Record<string, unknown>>(resolve(repositoryRoot, runtimePath));
  if (
    runtimeBefore.packageVersion !== candidate.version ||
    runtimeAfter.packageVersion !== stable.version
  ) {
    throw new Error("The runtime manifest does not have the expected RC and stable versions.");
  }
  runtimeBefore.packageVersion = "<release-version>";
  runtimeAfter.packageVersion = "<release-version>";
  if (JSON.stringify(runtimeBefore) !== JSON.stringify(runtimeAfter)) {
    throw new Error("The runtime manifest changes more than its package version.");
  }

  const lockBefore = Bun.JSONC.parse(gitOutput(["show", `${candidate.testedRevision}:bun.lock`])) as {
    workspaces: Record<string, { version?: string }>;
  };
  const lockAfter = Bun.JSONC.parse(readFileSync(resolve(repositoryRoot, "bun.lock"), "utf8")) as {
    workspaces: Record<string, { version?: string }>;
  };
  for (const releasePackage of publicPackages) {
    const workspace = `packages/${releasePackage.directory}`;
    if (
      lockBefore.workspaces[workspace]?.version !== candidate.version ||
      lockAfter.workspaces[workspace]?.version !== stable.version
    ) {
      throw new Error(`bun.lock does not have the expected versions for ${workspace}.`);
    }
    lockBefore.workspaces[workspace].version = "<release-version>";
    lockAfter.workspaces[workspace].version = "<release-version>";
  }
  if (JSON.stringify(lockBefore) !== JSON.stringify(lockAfter)) {
    throw new Error("bun.lock changes more than the coordinated workspace versions.");
  }
};

const packageJsonFromArchive = (archive: string): PackageJson => {
  const result = Bun.spawnSync(["tar", "-xOf", archive, "package/package.json"]);
  if (result.exitCode !== 0) {
    throw new Error(`Cannot read package/package.json from ${archive}: ${result.stderr.toString()}`);
  }
  return JSON.parse(result.stdout.toString()) as PackageJson;
};

const archiveEntries = (archive: string): ReadonlyArray<string> => {
  const result = Bun.spawnSync(["tar", "-tzf", archive]);
  if (result.exitCode !== 0) {
    throw new Error(`Cannot inspect ${archive}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().split("\n");
};

const run = (
  command: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {},
): string => {
  const result = Bun.spawnSync(command, options);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  }
  const output = result.stdout.toString();
  if (output.length > 0) process.stdout.write(output);
  return output;
};

const packRelease = (version: string, archiveDirectory: string): void => {
  assertCoordinatedVersion(version);
  mkdirSync(archiveDirectory, { recursive: true });
  if (readdirSync(archiveDirectory).length > 0) {
    throw new Error(`Archive directory '${archiveDirectory}' is not empty.`);
  }

  for (const releasePackage of publicPackages) {
    run(
      ["bun", "pm", "pack", "--destination", resolve(archiveDirectory), "--quiet"],
      { cwd: resolve(repositoryRoot, "packages", releasePackage.directory) },
    );
  }

  const archives = readdirSync(archiveDirectory)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => resolve(archiveDirectory, entry));
  for (const archive of archives) {
    const entries = archiveEntries(archive);
    if (entries.some((entry) => entry.startsWith("package/tests/"))) {
      throw new Error(`${archive} contains its test suite.`);
    }
    if (!entries.includes("package/LICENSE")) throw new Error(`${archive} has no LICENSE.`);
  }

  const byName = new Map(archives.map((archive) => [packageJsonFromArchive(archive).name, archive]));
  const kojoEntries = archiveEntries(byName.get("@carere/kojo") ?? "");
  if (!kojoEntries.includes("package/console/index.html")) {
    throw new Error("The Kojo archive has no Console shell.");
  }
  const runtimeEntries = archiveEntries(byName.get("@carere/kojo-runtime") ?? "");
  for (const required of [
    "package/runtime-manifest.json",
    "package/src/runner/main.ts",
    "package/src/validator/main.ts",
  ]) {
    if (!runtimeEntries.includes(required)) {
      throw new Error(`The runtime archive is missing ${required}.`);
    }
  }
};

const digest = (algorithm: "sha256" | "sha512", path: string, encoding: "base64" | "hex") =>
  createHash(algorithm).update(readFileSync(path)).digest(encoding);

const createManifest = (
  version: string,
  stage: ReleaseStage,
  testedRevision: string,
  archiveDirectory: string,
): ReleaseManifest => {
  const release = assertReleaseStage(version, stage);
  assertCoordinatedVersion(version);

  const archives = readdirSync(archiveDirectory)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => resolve(archiveDirectory, entry));
  if (archives.length !== publicPackages.length) {
    throw new Error("The package directory does not contain exactly four package archives.");
  }
  const byName = new Map(archives.map((archive) => [packageJsonFromArchive(archive).name, archive]));

  const packages = publicPackages.map(({ name }) => {
    const archive = byName.get(name);
    if (archive === undefined) throw new Error(`The package set has no archive for ${name}.`);
    const packageJson = packageJsonFromArchive(archive);
    if (packageJson.version !== version) {
      throw new Error(`${name} archive contains '${packageJson.version}', not '${version}'.`);
    }
    return {
      archive: basename(archive),
      integrity: `sha512-${digest("sha512", archive, "base64")}`,
      name,
      sha256: digest("sha256", archive, "hex"),
      size: statSync(archive).size,
      version,
    };
  });

  if (byName.size !== publicPackages.length) {
    throw new Error("The package directory contains an archive outside the coordinated package set.");
  }

  return {
    baseVersion: release.baseVersion,
    formatVersion: 1,
    packages,
    runId: process.env.GITHUB_RUN_ID,
    stage,
    testedRevision,
    version,
  };
};

const readManifest = (path: string): ReleaseManifest => readJson<ReleaseManifest>(path);

const assertManifest = (
  manifest: ReleaseManifest,
  version: string,
  stage: ReleaseStage,
  testedRevision?: string,
): void => {
  const release = assertReleaseStage(version, stage);
  if (manifest.formatVersion !== 1) throw new Error("The Release manifest format is not supported.");
  if (manifest.version !== version || manifest.stage !== stage) {
    throw new Error(`The Release manifest does not describe ${stage} ${version}.`);
  }
  if (manifest.baseVersion !== release.baseVersion) {
    throw new Error("The Release manifest has an incorrect base version.");
  }
  if (testedRevision !== undefined && manifest.testedRevision !== testedRevision) {
    throw new Error(
      `The Release manifest tested '${manifest.testedRevision}', not '${testedRevision}'.`,
    );
  }
  if (manifest.packages.length !== publicPackages.length) {
    throw new Error("The Release manifest does not contain the coordinated package set.");
  }
  for (const [index, expected] of publicPackages.entries()) {
    const actual = manifest.packages[index];
    if (
      actual?.name !== expected.name ||
      actual.version !== version ||
      !actual.integrity.startsWith("sha512-") ||
      !/^[a-f0-9]{64}$/.test(actual.sha256)
    ) {
      throw new Error(`The Release manifest has an invalid entry for ${expected.name}.`);
    }
  }
};

const registryMetadata = async (name: string): Promise<RegistryMetadata | undefined> => {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Registry lookup for ${name} failed with ${response.status}.`);
  return (await response.json()) as RegistryMetadata;
};

const assertUnpublished = async (version: string): Promise<void> => {
  for (const { name } of publicPackages) {
    const metadata = await registryMetadata(name);
    if (metadata?.versions?.[version] !== undefined) {
      throw new Error(`${name}@${version} already exists. Published versions are immutable.`);
    }
  }
};

const waitForPublishedVersion = async (
  name: string,
  version: string,
): Promise<RegistryVersion | undefined> => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const published = (await registryMetadata(name))?.versions?.[version];
    if (published !== undefined) return published;
    if (attempt < 5) await Bun.sleep(2 ** attempt * 1_000);
  }
  return undefined;
};

const publishRelease = (manifestPath: string, tag: string): void => {
  const manifest = readManifest(manifestPath);
  assertManifest(manifest, manifest.version, manifest.stage);
  const token = process.env.NPM_TOKEN;
  if (token === undefined || token.length === 0) throw new Error("NPM_TOKEN is not set.");

  for (const releasePackage of manifest.packages) {
    run(
      [
        "bun",
        "publish",
        "--access",
        "public",
        "--tag",
        tag,
        resolve(dirname(manifestPath), "packages", releasePackage.archive),
      ],
      { env: { ...process.env, NPM_CONFIG_TOKEN: token } },
    );
  }
};

const installRelease = (manifestPath: string, project: string, globalRoot: string): void => {
  const manifest = readManifest(manifestPath);
  assertManifest(manifest, manifest.version, manifest.stage);
  mkdirSync(project, { recursive: true });
  const environment = { ...process.env, BUN_INSTALL: globalRoot };
  run(["bun", "init", "-y"], { cwd: project, env: environment });
  run(
    [
      "bun",
      "add",
      "--exact",
      ...manifest.packages
        .slice(0, -1)
        .map((releasePackage) => `${releasePackage.name}@${releasePackage.version}`),
    ],
    { cwd: project, env: environment },
  );
  const cli = manifest.packages.at(-1);
  if (cli === undefined) throw new Error("The Release manifest has no CLI package.");
  run(["bun", "add", "-g", `${cli.name}@${cli.version}`], { cwd: project, env: environment });
  const actualVersion = run([resolve(globalRoot, "bin/kojo"), "--version"], {
    cwd: project,
    env: environment,
  }).trim();
  if (actualVersion !== `kojo v${manifest.version}`) {
    throw new Error(`The installed CLI reports '${actualVersion}', not 'kojo v${manifest.version}'.`);
  }
};

const verifyPublished = async (manifest: ReleaseManifest): Promise<void> => {
  assertManifest(manifest, manifest.version, manifest.stage);
  for (const releasePackage of manifest.packages) {
    const published = await waitForPublishedVersion(
      releasePackage.name,
      releasePackage.version,
    );
    if (published === undefined) {
      throw new Error(`${releasePackage.name}@${releasePackage.version} is not in the registry.`);
    }
    if (published.dist?.integrity !== releasePackage.integrity) {
      throw new Error(
        `${releasePackage.name}@${releasePackage.version} does not match the tested archive.`,
      );
    }
  }
};

const verifyActiveTags = async (manifest: ReleaseManifest): Promise<void> => {
  assertManifest(manifest, manifest.version, manifest.stage);
  if (manifest.stage === "stable") throw new Error("A stable Release is not a prerelease candidate.");
  for (const releasePackage of manifest.packages) {
    const tags = (await registryMetadata(releasePackage.name))?.["dist-tags"];
    if (tags?.[manifest.stage] !== manifest.version || tags.next !== manifest.version) {
      throw new Error(`${releasePackage.name}@${manifest.version} is not the active candidate.`);
    }
  }
};

const usage = (): never => {
  throw new Error(
    "Usage: release-train.ts validate-prerelease <stage> <version> [previous] | validate-stable <version> <rc-version> | validate-stable-source <manifest> <revision> | verify-predecessor <manifest> <version> <previous> | pack <version> <archive-directory> | create-manifest <stage> <version> <revision> <archive-directory> <output> | verify-manifest <manifest> <stage> <version> [revision] | assert-unpublished <version> | publish <manifest> <tag> | verify-published <manifest> | verify-active-tags <manifest> | install <manifest> <project-directory> <global-directory>",
  );
};

const [command, ...arguments_] = Bun.argv.slice(2);

switch (command) {
  case "validate-prerelease": {
    const [stage, version, previous] = arguments_;
    if (stage === undefined || version === undefined) usage();
    assertReleaseStage(version, stage as ReleaseStage);
    assertPrereleaseFollowsCandidate(version, previous);
    assertCoordinatedVersion(version);
    assertCocogittoBump(version);
    break;
  }
  case "validate-stable": {
    const [version, releaseCandidate] = arguments_;
    if (version === undefined || releaseCandidate === undefined) usage();
    assertStableFollowsCandidate(version, releaseCandidate);
    assertCoordinatedVersion(version);
    assertCocogittoBump(version);
    break;
  }
  case "validate-stable-source": {
    const [path, revision] = arguments_;
    if (path === undefined || revision === undefined) usage();
    assertStableSource(path, revision);
    break;
  }
  case "create-manifest": {
    const [stage, version, revision, archiveDirectory, output] = arguments_;
    if ([stage, version, revision, archiveDirectory, output].some((value) => value === undefined)) {
      usage();
    }
    const manifest = createManifest(
      version as string,
      stage as ReleaseStage,
      revision as string,
      archiveDirectory as string,
    );
    writeFileSync(output as string, `${JSON.stringify(manifest, null, 2)}\n`);
    break;
  }
  case "pack": {
    const [version, archiveDirectory] = arguments_;
    if (version === undefined || archiveDirectory === undefined) usage();
    packRelease(version, archiveDirectory);
    break;
  }
  case "verify-manifest": {
    const [path, stage, version, revision] = arguments_;
    if (path === undefined || stage === undefined || version === undefined) usage();
    assertManifest(readManifest(path), version, stage as ReleaseStage, revision);
    break;
  }
  case "verify-predecessor": {
    const [path, version, previous] = arguments_;
    if (path === undefined || version === undefined || previous === undefined) usage();
    assertPrereleaseFollowsCandidate(version, previous);
    const previousRelease = parseReleaseVersion(previous);
    assertManifest(readManifest(path), previous, previousRelease.stage);
    break;
  }
  case "assert-unpublished": {
    const [version] = arguments_;
    if (version === undefined) usage();
    await assertUnpublished(version);
    break;
  }
  case "publish": {
    const [path, tag] = arguments_;
    if (path === undefined || tag === undefined) usage();
    publishRelease(path, tag);
    break;
  }
  case "verify-published": {
    const [path] = arguments_;
    if (path === undefined) usage();
    await verifyPublished(readManifest(path));
    break;
  }
  case "verify-active-tags": {
    const [path] = arguments_;
    if (path === undefined) usage();
    await verifyActiveTags(readManifest(path));
    break;
  }
  case "install": {
    const [path, project, globalRoot] = arguments_;
    if (path === undefined || project === undefined || globalRoot === undefined) usage();
    installRelease(path, project, globalRoot);
    break;
  }
  default:
    usage();
}
