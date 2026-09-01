import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Effect } from "effect";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  CheckedManagedReleaseManifest,
  ManagedReleaseCompatibility,
  ManagedReleaseFile,
  ManagedReleaseMigration,
} from "../models/ManagedRelease.ts";
import type { ManagedReleaseSelection } from "../ports/ManagedReleaseSelection.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  atomicPrivateFileInOwnedDirectory,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";

export interface ManagedInstallationOptions {
  readonly paths: DaemonPaths;
  readonly sourceRoot?: string;
  readonly bunExecutable?: string;
  readonly consoleRoot?: string;
  readonly serviceDocument: (paths: DaemonPaths) => string;
}

export interface StageManagedReleaseOptions {
  readonly paths: DaemonPaths;
  readonly expectedVersion: string;
  readonly sourceRoot?: string;
  readonly bunExecutable?: string;
  readonly consoleRoot?: string;
  readonly now?: () => number;
}

export interface InstallationResult {
  readonly outcome: "installed" | "kept";
  readonly releaseId: string;
}

const sourcePackage = new URL("../../../../", import.meta.url).pathname;

const manifestAt = (root: string): { readonly version: string } =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { readonly version: string };

const sha256 = (bytes: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const relativeManagedPath = (root: string, path: string): string =>
  relative(root, path).split(sep).join("/");

const payloadFiles = (root: string): ReadonlyArray<ManagedReleaseFile> => {
  const files: ManagedReleaseFile[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new LifecycleError(
        "UNSAFE_RELEASE",
        `managed release contains a symbolic link: ${path}`,
      );
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    if (!stat.isFile()) {
      throw new LifecycleError(
        "UNSAFE_RELEASE",
        `managed release contains a special file: ${path}`,
      );
    }
    const selected = relativeManagedPath(root, path);
    if (selected !== "release.json") {
      const bytes = readFileSync(path);
      files.push({
        path: selected,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        mode: stat.mode & 0o777,
      });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

const releaseDigest = (
  manifest: Omit<CheckedManagedReleaseManifest, "releaseId" | "createdAt">,
): string => sha256(JSON.stringify(manifest));

const safeReleasePart = (value: string, name: string): string => {
  if (value.length === 0 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new LifecycleError(
      "MANAGED_RELEASE_INVALID",
      `the ${name} is not safe for a release identity`,
    );
  }
  return value;
};

const bunVersionAt = (executable: string): string => {
  const result = Bun.spawnSync([executable, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const version = result.stdout.toString().trim();
  if (result.exitCode !== 0 || version.length === 0 || !/^[A-Za-z0-9.+_-]+$/.test(version)) {
    throw new LifecycleError(
      "MANAGED_BUN_INVALID",
      "the candidate Bun executable did not report a valid exact version",
    );
  }
  return version;
};

const hasOnlyKeys = (value: object, allowed: ReadonlyArray<string>): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const checkedManifest = (value: unknown): CheckedManagedReleaseManifest => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleError("MANAGED_RELEASE_INCOMPLETE", "the candidate manifest is invalid");
  }
  const manifest = value as Partial<CheckedManagedReleaseManifest>;
  const compatibility = manifest.compatibility;
  if (
    !hasOnlyKeys(value, [
      "formatVersion",
      "releaseId",
      "kojoVersion",
      "bunVersion",
      "createdAt",
      "host",
      "compatibility",
      "migration",
      "files",
    ]) ||
    manifest.formatVersion !== 2 ||
    typeof manifest.releaseId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(manifest.releaseId) ||
    typeof manifest.kojoVersion !== "string" ||
    manifest.kojoVersion.length === 0 ||
    typeof manifest.bunVersion !== "string" ||
    manifest.bunVersion.length === 0 ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    manifest.host === undefined ||
    manifest.host === null ||
    !hasOnlyKeys(manifest.host, ["os", "arch"]) ||
    typeof manifest.host.os !== "string" ||
    manifest.host.os.length === 0 ||
    typeof manifest.host.arch !== "string" ||
    manifest.host.arch.length === 0 ||
    compatibility === undefined ||
    compatibility === null ||
    !hasOnlyKeys(compatibility, [
      "dataFormats",
      "revisionFormats",
      "runnerProtocols",
      "requiredFeatures",
    ]) ||
    !Array.isArray(compatibility.dataFormats) ||
    !compatibility.dataFormats.every((entry) => Number.isSafeInteger(entry) && entry > 0) ||
    !Array.isArray(compatibility.revisionFormats) ||
    !compatibility.revisionFormats.every((entry) => Number.isSafeInteger(entry) && entry > 0) ||
    !Array.isArray(compatibility.runnerProtocols) ||
    !compatibility.runnerProtocols.every((entry) => Number.isSafeInteger(entry) && entry > 0) ||
    !Array.isArray(compatibility.requiredFeatures) ||
    !compatibility.requiredFeatures.every((entry) => typeof entry === "string") ||
    !Array.isArray(manifest.files)
  ) {
    throw new LifecycleError("MANAGED_RELEASE_INCOMPLETE", "the candidate manifest is incomplete");
  }
  if (
    manifest.migration !== undefined &&
    (!hasOnlyKeys(manifest.migration, [
      "fromDataFormat",
      "toDataFormat",
      "rollback",
      "description",
    ]) ||
      !Number.isSafeInteger(manifest.migration.fromDataFormat) ||
      !Number.isSafeInteger(manifest.migration.toDataFormat) ||
      (manifest.migration.rollback !== "preserved" && manifest.migration.rollback !== "lost") ||
      typeof manifest.migration.description !== "string" ||
      manifest.migration.description.length === 0)
  ) {
    throw new LifecycleError("MANAGED_RELEASE_INCOMPLETE", "the candidate migration is invalid");
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (
      file === null ||
      typeof file !== "object" ||
      !hasOnlyKeys(file, ["path", "sha256", "size", "mode"]) ||
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.split("/").some((part: string) => part === "" || part === "." || part === "..") ||
      seen.has(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777
    ) {
      throw new LifecycleError("MANAGED_RELEASE_INCOMPLETE", "the candidate checksums are invalid");
    }
    seen.add(file.path);
  }
  return manifest as CheckedManagedReleaseManifest;
};

interface CandidateManagedReleaseMetadata {
  readonly formatVersion: 1;
  readonly compatibility: ManagedReleaseCompatibility;
  readonly migration?: ManagedReleaseMigration;
}

const candidateMetadataAt = (root: string): CandidateManagedReleaseMetadata => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(root, "managed-release.json"), "utf8")) as unknown;
  } catch (cause) {
    throw new LifecycleError(
      "MANAGED_RELEASE_METADATA_INVALID",
      "the candidate package has no valid managed release metadata",
      cause,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleError(
      "MANAGED_RELEASE_METADATA_INVALID",
      "the candidate package managed release metadata is invalid",
    );
  }
  const metadata = value as Partial<CandidateManagedReleaseMetadata>;
  const compatibility = metadata.compatibility;
  const migration = metadata.migration;
  if (
    !hasOnlyKeys(value, ["formatVersion", "compatibility", "migration"]) ||
    metadata.formatVersion !== 1 ||
    compatibility === undefined ||
    compatibility === null ||
    !hasOnlyKeys(compatibility, [
      "dataFormats",
      "revisionFormats",
      "runnerProtocols",
      "requiredFeatures",
    ]) ||
    !Array.isArray(compatibility.dataFormats) ||
    !compatibility.dataFormats.every((entry) => Number.isSafeInteger(entry) && entry > 0) ||
    !Array.isArray(compatibility.revisionFormats) ||
    !compatibility.revisionFormats.every((entry) => Number.isSafeInteger(entry) && entry > 0) ||
    !Array.isArray(compatibility.runnerProtocols) ||
    !compatibility.runnerProtocols.every((entry) => Number.isSafeInteger(entry) && entry > 0) ||
    !Array.isArray(compatibility.requiredFeatures) ||
    !compatibility.requiredFeatures.every(
      (entry) => typeof entry === "string" && entry.length > 0,
    ) ||
    (migration !== undefined &&
      (!hasOnlyKeys(migration, ["fromDataFormat", "toDataFormat", "rollback", "description"]) ||
        !Number.isSafeInteger(migration.fromDataFormat) ||
        !Number.isSafeInteger(migration.toDataFormat) ||
        (migration.rollback !== "preserved" && migration.rollback !== "lost") ||
        typeof migration.description !== "string" ||
        migration.description.length === 0))
  ) {
    throw new LifecycleError(
      "MANAGED_RELEASE_METADATA_INVALID",
      "the candidate package managed release declarations are invalid",
    );
  }
  return metadata as CandidateManagedReleaseMetadata;
};

const immutable = (path: string): void => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new LifecycleError("UNSAFE_RELEASE", `managed release contains a symbolic link: ${path}`);
  }
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) immutable(join(path, child));
    chmodSync(path, 0o500);
  } else {
    const executable = (stat.mode & 0o100) !== 0;
    chmodSync(path, executable ? 0o500 : 0o400);
  }
};

const discardTree = (path: string): void => {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) discardTree(join(path, child));
  } else if (!stat.isSymbolicLink()) {
    chmodSync(path, 0o600);
  }
  rmSync(path, { recursive: true, force: true });
};

const stableProgram = (
  installationRoot: string,
  entry: "cli.js" | "launcher.js",
): string => `#!/bin/sh
set -eu
installation=${JSON.stringify(installationRoot)}
release="$(/bin/cat "$installation/active-release")"
case "$release" in
  *[!A-Za-z0-9._-]*|'') echo "kojo: invalid managed release identity" >&2; exit 1 ;;
esac
exec "$installation/releases/$release/runtime/bun" "$installation/releases/$release/${entry}" "$@"
`;

const buildEntry = async (entrypoint: string, outdir: string, name: string): Promise<void> => {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    naming: name,
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    const reason = result.logs.map((log) => log.message).join("; ");
    throw new LifecycleError("MANAGED_RELEASE_BUILD_FAILED", reason || `could not build ${name}`);
  }
};

const releaseIdentityPayload = (
  manifest: Omit<CheckedManagedReleaseManifest, "releaseId">,
): Omit<CheckedManagedReleaseManifest, "releaseId" | "createdAt"> => ({
  formatVersion: 2,
  kojoVersion: manifest.kojoVersion,
  bunVersion: manifest.bunVersion,
  host: manifest.host,
  compatibility: manifest.compatibility,
  ...(manifest.migration === undefined ? {} : { migration: manifest.migration }),
  files: manifest.files,
});

export const readCheckedManagedRelease = (
  paths: DaemonPaths,
  releaseId: string,
): CheckedManagedReleaseManifest => {
  safeReleasePart(releaseId, "release identity");
  const release = join(paths.installationRoot, "releases", releaseId);
  if (!existsSync(release)) {
    throw new LifecycleError(
      "MANAGED_RELEASE_NOT_STAGED",
      "the requested managed release candidate is not staged",
    );
  }
  const releaseStat = lstatSync(release);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) {
    throw new LifecycleError(
      "MANAGED_RELEASE_INCOMPLETE",
      "the staged candidate is not a directory",
    );
  }
  const manifestPath = join(release, "release.json");
  if (!existsSync(manifestPath)) {
    throw new LifecycleError(
      "MANAGED_RELEASE_INCOMPLETE",
      "the staged candidate manifest is absent",
    );
  }
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new LifecycleError(
      "MANAGED_RELEASE_INCOMPLETE",
      "the staged candidate manifest is absent",
    );
  }
  let manifest: CheckedManagedReleaseManifest;
  try {
    manifest = checkedManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
  } catch (cause) {
    if (cause instanceof LifecycleError) throw cause;
    throw new LifecycleError(
      "MANAGED_RELEASE_INCOMPLETE",
      "the candidate manifest is invalid",
      cause,
    );
  }
  if (manifest.releaseId !== releaseId) {
    throw new LifecycleError(
      "MANAGED_RELEASE_INCOMPLETE",
      "the candidate directory and manifest name different releases",
    );
  }
  const expectedReleaseId = `kojo-${safeReleasePart(manifest.kojoVersion, "Kojo version")}-bun-${safeReleasePart(manifest.bunVersion, "Bun version")}-${releaseDigest(releaseIdentityPayload(manifest)).slice(0, 24)}`;
  if (expectedReleaseId !== releaseId) {
    throw new LifecycleError(
      "MANAGED_RELEASE_CORRUPT",
      "the candidate manifest does not match its content identity",
    );
  }
  const authored = candidateMetadataAt(release);
  if (
    JSON.stringify(authored.compatibility) !== JSON.stringify(manifest.compatibility) ||
    JSON.stringify(authored.migration) !== JSON.stringify(manifest.migration)
  ) {
    throw new LifecycleError(
      "MANAGED_RELEASE_CORRUPT",
      "the candidate manifest does not match its checksummed package declarations",
    );
  }
  const actual = payloadFiles(release);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new LifecycleError(
      "MANAGED_RELEASE_CORRUPT",
      "the candidate files, modes, sizes, or checksums do not match its manifest",
    );
  }
  const required = new Set([
    "cli.js",
    "launcher.js",
    "runtime/bun",
    "console/index.html",
    "managed-release.json",
  ]);
  for (const file of actual) required.delete(file.path);
  if (required.size > 0) {
    throw new LifecycleError(
      "MANAGED_RELEASE_INCOMPLETE",
      `the candidate is missing ${[...required].sort().join(", ")}`,
    );
  }
  return manifest;
};

/** Publish one immutable candidate without selecting it or changing native service state. */
export const stageManagedRelease = (
  options: StageManagedReleaseOptions,
): Effect.Effect<CheckedManagedReleaseManifest, LifecycleError> =>
  Effect.tryPromise({
    try: async () => {
      const { paths } = options;
      const root = options.sourceRoot ?? sourcePackage;
      const packageManifest = manifestAt(root);
      const candidateMetadata = candidateMetadataAt(root);
      if (packageManifest.version !== options.expectedVersion) {
        throw new LifecycleError(
          "MANAGED_RELEASE_VERSION_UNAVAILABLE",
          `this Kojo package is ${packageManifest.version}, not requested ${options.expectedVersion}; install the exact candidate package first`,
        );
      }
      safeReleasePart(packageManifest.version, "Kojo version");
      const bunExecutable = options.bunExecutable ?? process.execPath;
      const bunVersion = bunVersionAt(bunExecutable);
      safeReleasePart(bunVersion, "Bun version");
      const releases = join(paths.installationRoot, "releases");
      const stagingRoot = join(paths.installationRoot, "staging");
      const staging = join(stagingRoot, crypto.randomUUID());
      ensurePrivateDirectory(paths.installationRoot);
      ensurePrivateDirectory(releases);
      ensurePrivateDirectory(stagingRoot);
      ensurePrivateDirectory(staging);
      mkdirSync(join(staging, "runtime"), { mode: 0o700 });
      try {
        cpSync(bunExecutable, join(staging, "runtime", "bun"), { errorOnExist: true });
        chmodSync(join(staging, "runtime", "bun"), 0o700);
        await buildEntry(join(root, "src", "main.ts"), staging, "cli.js");
        await buildEntry(join(root, "src", "launcher", "main.ts"), staging, "launcher.js");
        const consoleAssets = options.consoleRoot ?? join(root, "console");
        if (!existsSync(join(consoleAssets, "index.html"))) {
          throw new LifecycleError(
            "CONSOLE_ASSETS_MISSING",
            "the candidate Kojo package does not contain its Console build",
          );
        }
        cpSync(consoleAssets, join(staging, "console"), { recursive: true });
        cpSync(join(root, "managed-release.json"), join(staging, "managed-release.json"), {
          errorOnExist: true,
        });

        immutable(staging);
        chmodSync(staging, 0o700);
        const identity = {
          formatVersion: 2,
          kojoVersion: packageManifest.version,
          bunVersion,
          createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
          host: { os: process.platform, arch: process.arch },
          compatibility: candidateMetadata.compatibility,
          ...(candidateMetadata.migration === undefined
            ? {}
            : { migration: candidateMetadata.migration }),
          files: payloadFiles(staging),
        } satisfies Omit<CheckedManagedReleaseManifest, "releaseId">;
        const releaseId = `kojo-${packageManifest.version}-bun-${bunVersion}-${releaseDigest(releaseIdentityPayload(identity)).slice(0, 24)}`;
        const release = join(releases, releaseId);
        const manifest: CheckedManagedReleaseManifest = { ...identity, releaseId };
        atomicPrivateFile(join(staging, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        immutable(staging);
        chmodSync(staging, 0o700);

        if (!existsSync(release)) {
          renameSync(staging, release);
          immutable(release);
        } else {
          discardTree(staging);
        }
        return readCheckedManagedRelease(paths, releaseId);
      } catch (cause) {
        if (existsSync(staging)) discardTree(staging);
        if (cause instanceof LifecycleError) throw cause;
        throw new LifecycleError(
          "MANAGED_RELEASE_STAGE_FAILED",
          "the candidate managed release could not be staged",
          cause,
        );
      }
    },
    catch: (cause) =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "MANAGED_RELEASE_STAGE_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
  });

export const managedInstallationIsPresent = (paths: DaemonPaths): boolean => {
  try {
    const owner = process.getuid?.() ?? -1;
    const privateFile = (path: string): boolean => {
      const stat = lstatSync(path);
      return (
        stat.isFile() && !stat.isSymbolicLink() && stat.uid === owner && (stat.mode & 0o077) === 0
      );
    };
    if (!privateFile(paths.managedCli) || !privateFile(paths.managedLauncher)) return false;
    const active = join(paths.installationRoot, "active-release");
    if (!privateFile(active)) return false;
    const releaseId = readFileSync(active, "utf8").trim();
    const release = join(paths.installationRoot, "releases", releaseId);
    const releaseStat = lstatSync(release);
    return (
      /^[A-Za-z0-9._-]+$/.test(releaseId) &&
      releaseStat.isDirectory() &&
      !releaseStat.isSymbolicLink() &&
      releaseStat.uid === owner &&
      (releaseStat.mode & 0o277) === 0 &&
      privateFile(join(release, "release.json")) &&
      privateFile(join(release, "runtime", "bun")) &&
      privateFile(join(release, "cli.js")) &&
      privateFile(join(release, "launcher.js")) &&
      privateFile(join(release, "console", "index.html"))
    );
  } catch {
    return false;
  }
};

const deleteOwnedManagedTree = (path: string): void => {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== (process.getuid?.() ?? -1) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new LifecycleError("UNSAFE_MANAGED_INSTALLATION", `${path} is not private owned content`);
  }
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) deleteOwnedManagedTree(join(path, child));
    rmdirSync(path);
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new LifecycleError(
      "UNSAFE_MANAGED_INSTALLATION",
      `${path} is not a private regular managed file`,
    );
  }
  chmodSync(path, 0o600);
  unlinkSync(path);
};

/** Remove only managed executable content. Daemon data, configuration, cache, and Projects remain. */
export const removeManagedInstallation = (paths: DaemonPaths): void => {
  for (const path of [
    join(paths.installationRoot, "active-release"),
    join(paths.installationRoot, "releases"),
    join(paths.installationRoot, "staging"),
    paths.managedCli,
    paths.managedLauncher,
  ]) {
    deleteOwnedManagedTree(path);
  }
  const bin = dirname(paths.managedCli);
  if (existsSync(bin) && readdirSync(bin).length === 0) deleteOwnedManagedTree(bin);
};

export const managedReleaseSelection = (paths: DaemonPaths): ManagedReleaseSelection => {
  const activePath = join(paths.installationRoot, "active-release");
  const read = (): string => {
    assertPrivateNode(activePath, "file");
    const releaseId = readFileSync(activePath, "utf8").trim();
    safeReleasePart(releaseId, "active managed release identity");
    return releaseId;
  };
  return {
    read,
    select: (expectedReleaseId, nextReleaseId) => {
      const current = read();
      if (current === nextReleaseId) {
        readCheckedManagedRelease(paths, nextReleaseId);
        return current;
      }
      if (current !== expectedReleaseId) {
        throw new LifecycleError(
          "ACTIVE_RELEASE_CHANGED",
          `the active managed release is ${current}, not expected ${expectedReleaseId}`,
        );
      }
      readCheckedManagedRelease(paths, nextReleaseId);
      atomicPrivateFile(activePath, `${nextReleaseId}\n`);
      return read();
    },
  };
};

export const installManagedRelease = (
  options: ManagedInstallationOptions,
): Effect.Effect<InstallationResult, LifecycleError> =>
  Effect.tryPromise({
    try: async () => {
      const { paths } = options;
      if (managedInstallationIsPresent(paths)) {
        return {
          outcome: "kept",
          releaseId: readFileSync(join(paths.installationRoot, "active-release"), "utf8").trim(),
        } as const;
      }

      ensurePrivateDirectory(paths.installationRoot);
      ensurePrivateDirectory(paths.configurationRoot);
      ensurePrivateDirectory(paths.cacheRoot);
      ensurePrivateDirectory(paths.runtimeRoot);
      try {
        const packageManifest = manifestAt(options.sourceRoot ?? sourcePackage);
        const candidate = await Effect.runPromise(
          stageManagedRelease({
            paths,
            expectedVersion: packageManifest.version,
            ...(options.sourceRoot === undefined ? {} : { sourceRoot: options.sourceRoot }),
            ...(options.bunExecutable === undefined
              ? {}
              : { bunExecutable: options.bunExecutable }),
            ...(options.consoleRoot === undefined ? {} : { consoleRoot: options.consoleRoot }),
          }),
        );

        ensurePrivateDirectory(dirname(paths.managedCli));
        atomicPrivateFile(paths.managedCli, stableProgram(paths.installationRoot, "cli.js"), 0o700);
        atomicPrivateFile(
          paths.managedLauncher,
          stableProgram(paths.installationRoot, "launcher.js"),
          0o700,
        );
        atomicPrivateFile(
          join(paths.installationRoot, "active-release"),
          `${candidate.releaseId}\n`,
        );
        atomicPrivateFileInOwnedDirectory(paths.serviceDefinition, options.serviceDocument(paths));
        return { outcome: "installed", releaseId: candidate.releaseId } as const;
      } catch (cause) {
        if (cause instanceof LifecycleError) throw cause;
        throw new LifecycleError("MANAGED_RELEASE_INSTALL_FAILED", "could not install Kojo", cause);
      }
    },
    catch: (cause) =>
      cause instanceof LifecycleError
        ? cause
        : new LifecycleError(
            "MANAGED_RELEASE_INSTALL_FAILED",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
  });
