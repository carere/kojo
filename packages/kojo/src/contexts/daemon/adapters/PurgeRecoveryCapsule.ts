import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";

export interface PurgeRecoveryCapsule {
  readonly formatVersion: 1;
  readonly dataIdentity: string;
  readonly sourceReleaseId: string;
  readonly bunSha256: string;
  readonly launcherSha256: string;
  readonly manifestSha256: string;
  readonly bun: string;
  readonly launcher: string;
  readonly manifest: string;
}

export interface PurgeRecoveryCapsuleAuthorization {
  readonly formatVersion: 1;
  readonly kind: "purge-recovery-capsule";
  readonly dataIdentity: string;
  readonly sourceReleaseId: string;
  readonly bunSha256: string;
  readonly launcherSha256: string;
  readonly manifestSha256: string;
  readonly seal: string;
}

const digest = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const capsuleRoot = (paths: Pick<DaemonPaths, "dataRoot">): string =>
  join(paths.dataRoot, "lifecycle", "purge-recovery-capsule");

export const purgeRecoveryCapsuleAuthorizationPath = (
  paths: Pick<DaemonPaths, "dataRoot">,
): string => join(capsuleRoot(paths), "authorization.json");

const atomicBytes = (path: string, bytes: Uint8Array, mode: number): void => {
  ensurePrivateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (stat.uid !== (process.getuid?.() ?? -1) || !stat.isFile() || stat.nlink !== 1) {
      throw new LifecycleError(
        "PURGE_RECOVERY_CAPSULE_UNSAFE",
        "the restricted recovery capsule temporary file is unsafe",
      );
    }
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};

export const readPurgeRecoveryCapsule = (
  paths: Pick<DaemonPaths, "dataRoot">,
  expectedDataIdentity?: string,
): PurgeRecoveryCapsule => {
  const root = capsuleRoot(paths);
  const manifestPath = join(root, "manifest.json");
  const bun = join(root, "runtime", "bun");
  const launcher = join(root, "launcher.js");
  assertPrivateNode(root, "directory");
  assertPrivateNode(manifestPath, "file");
  assertPrivateNode(bun, "file");
  assertPrivateNode(launcher, "file");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly formatVersion?: number;
    readonly dataIdentity?: string;
    readonly sourceReleaseId?: string;
    readonly bunSha256?: string;
    readonly launcherSha256?: string;
  };
  const bunSha256 = digest(readFileSync(bun));
  const launcherSha256 = digest(readFileSync(launcher));
  if (
    Object.keys(manifest).length !== 5 ||
    !Object.keys(manifest).every((key) =>
      ["formatVersion", "dataIdentity", "sourceReleaseId", "bunSha256", "launcherSha256"].includes(
        key,
      ),
    ) ||
    manifest.formatVersion !== 1 ||
    typeof manifest.dataIdentity !== "string" ||
    manifest.dataIdentity.length === 0 ||
    (expectedDataIdentity !== undefined && manifest.dataIdentity !== expectedDataIdentity) ||
    typeof manifest.sourceReleaseId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(manifest.sourceReleaseId) ||
    manifest.bunSha256 !== bunSha256 ||
    manifest.launcherSha256 !== launcherSha256
  ) {
    throw new LifecycleError(
      "PURGE_RECOVERY_CAPSULE_DAMAGED",
      "the identity-bound restricted recovery capsule is damaged",
    );
  }
  return {
    formatVersion: 1,
    dataIdentity: manifest.dataIdentity,
    sourceReleaseId: manifest.sourceReleaseId,
    bunSha256,
    launcherSha256,
    manifestSha256: digest(readFileSync(manifestPath)),
    bun,
    launcher,
    manifest: manifestPath,
  };
};

export const ensurePurgeRecoveryCapsule = (
  paths: DaemonPaths,
  dataIdentity: string,
  sourceReleaseId: string,
): PurgeRecoveryCapsule => {
  const release = join(paths.installationRoot, "releases", sourceReleaseId);
  const sourceBun = join(release, "runtime", "bun");
  const sourceLauncher = join(release, "launcher.js");
  assertPrivateNode(sourceBun, "file");
  assertPrivateNode(sourceLauncher, "file");
  const bunBytes = readFileSync(sourceBun);
  const launcherBytes = readFileSync(sourceLauncher);
  const root = capsuleRoot(paths);
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(join(root, "runtime"));
  atomicBytes(join(root, "runtime", "bun"), bunBytes, 0o700);
  atomicBytes(join(root, "launcher.js"), launcherBytes, 0o600);
  atomicPrivateFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      formatVersion: 1,
      dataIdentity,
      sourceReleaseId,
      bunSha256: digest(bunBytes),
      launcherSha256: digest(launcherBytes),
    })}\n`,
  );
  return readPurgeRecoveryCapsule(paths, dataIdentity);
};
