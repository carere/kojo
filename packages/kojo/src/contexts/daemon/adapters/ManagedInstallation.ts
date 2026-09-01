import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { ManagedReleaseManifest } from "../models/ManagedRelease.ts";
import {
  atomicPrivateFile,
  atomicPrivateFileInOwnedDirectory,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";

export interface ManagedInstallationOptions {
  readonly paths: DaemonPaths;
  readonly sourceRoot?: string;
  readonly bunExecutable?: string;
  readonly serviceDocument: (paths: DaemonPaths) => string;
}

export interface InstallationResult {
  readonly outcome: "installed" | "kept";
  readonly releaseId: string;
}

const sourcePackage = new URL("../../../../", import.meta.url).pathname;

const manifestAt = (root: string): { readonly version: string } =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { readonly version: string };

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

      const root = options.sourceRoot ?? sourcePackage;
      const packageManifest = manifestAt(root);
      const releaseId = `kojo-${packageManifest.version}-bun-${Bun.version}`;
      const releases = join(paths.installationRoot, "releases");
      const stagingRoot = join(paths.installationRoot, "staging");
      const staging = join(stagingRoot, crypto.randomUUID());
      const release = join(releases, releaseId);
      const bunExecutable = options.bunExecutable ?? process.execPath;

      ensurePrivateDirectory(paths.installationRoot);
      ensurePrivateDirectory(paths.dataRoot);
      ensurePrivateDirectory(paths.configurationRoot);
      ensurePrivateDirectory(paths.cacheRoot);
      ensurePrivateDirectory(paths.runtimeRoot);
      ensurePrivateDirectory(releases);
      ensurePrivateDirectory(stagingRoot);
      ensurePrivateDirectory(staging);
      mkdirSync(join(staging, "runtime"), { mode: 0o700 });

      try {
        cpSync(bunExecutable, join(staging, "runtime", "bun"), { errorOnExist: true });
        chmodSync(join(staging, "runtime", "bun"), 0o700);
        await buildEntry(join(root, "src", "main.ts"), staging, "cli.js");
        await buildEntry(join(root, "src", "launcher", "main.ts"), staging, "launcher.js");

        const consoleAssets = join(root, "console");
        if (!existsSync(join(consoleAssets, "index.html"))) {
          throw new LifecycleError(
            "CONSOLE_ASSETS_MISSING",
            "the installed Kojo package does not contain its Console build",
          );
        }
        cpSync(consoleAssets, join(staging, "console"), { recursive: true });
        const releaseManifest: ManagedReleaseManifest = {
          formatVersion: 1,
          releaseId,
          kojoVersion: packageManifest.version,
          bunVersion: Bun.version,
          createdAt: new Date().toISOString(),
        };
        atomicPrivateFile(
          join(staging, "release.json"),
          `${JSON.stringify(releaseManifest, null, 2)}\n`,
        );
        immutable(staging);
        chmodSync(staging, 0o700);

        if (!existsSync(release)) {
          renameSync(staging, release);
          immutable(release);
        } else discardTree(staging);

        ensurePrivateDirectory(dirname(paths.managedCli));
        atomicPrivateFile(paths.managedCli, stableProgram(paths.installationRoot, "cli.js"), 0o700);
        atomicPrivateFile(
          paths.managedLauncher,
          stableProgram(paths.installationRoot, "launcher.js"),
          0o700,
        );
        atomicPrivateFile(join(paths.installationRoot, "active-release"), `${releaseId}\n`);
        atomicPrivateFileInOwnedDirectory(paths.serviceDefinition, options.serviceDocument(paths));
      } catch (cause) {
        if (existsSync(staging)) {
          discardTree(staging);
        }
        if (cause instanceof LifecycleError) throw cause;
        throw new LifecycleError("MANAGED_RELEASE_INSTALL_FAILED", "could not install Kojo", cause);
      }

      if (!statSync(release).isDirectory() || basename(release) !== releaseId) {
        throw new LifecycleError(
          "MANAGED_RELEASE_INSTALL_FAILED",
          "managed release was not published",
        );
      }
      return { outcome: "installed", releaseId } as const;
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
