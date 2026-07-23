import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isProcessAlive, readLockRecord, systemPaths } from "./process";
import { kojoSchemaMigrations, kojoSchemaVersion, openSystemStore } from "./storage";

const backupFormatVersion = 1 as const;
const heldMaintenanceLocks = new Map<string, string>();

interface ArtifactRecord {
  readonly byte_length: number;
  readonly fingerprint: string;
  readonly path: string;
}

interface BackupManifestBody {
  readonly artifacts: ReadonlyArray<{
    readonly byteLength: number;
    readonly fingerprint: string;
    readonly path: string;
    readonly sha256: string;
  }>;
  readonly createdAt: string;
  readonly database: {
    readonly byteLength: number;
    readonly path: "state.sqlite";
    readonly sha256: string;
  };
  readonly formatVersion: typeof backupFormatVersion;
  readonly schemaVersion: number;
}

interface BackupManifest extends BackupManifestBody {
  readonly manifestChecksum: string;
}

export interface HomeDiagnostic {
  readonly code:
    | "ARTIFACT_CHECKSUM_MISMATCH"
    | "ARTIFACT_MISSING"
    | "DATABASE_CORRUPT"
    | "MIGRATION_FAILED"
    | "SCHEMA_VERSION_INCOMPATIBLE";
  readonly message: string;
  readonly path?: string;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const checksumFile = async (path: string) => sha256(await readFile(path));

const canonicalManifestBody = (manifest: BackupManifestBody) => JSON.stringify(manifest);

const assertSafeRelativePath = (path: string) => {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`Execution Artifact path is outside Kojo Home: ${path}`);
  }
};

const assertFinalizedArtifactPath = (path: string) => {
  assertSafeRelativePath(path);
  const parts = path.split(/[\\/]/);
  if (parts.length < 2 || parts[0] !== "artifacts" || parts[1] === "staging") {
    throw new Error(`Execution Artifact path is outside the finalized artifact store: ${path}`);
  }
};

const resolveInside = (root: string, path: string) => {
  assertSafeRelativePath(path);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(root, path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Execution Artifact path is outside Kojo Home: ${path}`);
  }
  return resolvedPath;
};

const resolveArtifactInside = (root: string, path: string) => {
  assertFinalizedArtifactPath(path);
  return resolveInside(root, path);
};

const assertNoSymbolicLinkComponents = async (
  root: string,
  path: string,
  options?: { readonly allowFinal?: boolean },
) => {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  let current = resolve(root);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const details = await lstat(current);
      if (
        details.isSymbolicLink() &&
        !(options?.allowFinal === true && index === parts.length - 1)
      ) {
        throw new Error(`Execution Artifact path contains a symbolic link: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
};

const readArtifacts = (database: Database): ReadonlyArray<ArtifactRecord> => {
  const table = database
    .query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'execution_artifacts'",
    )
    .get() as { readonly present: number } | null;
  if (table === null) return [];
  return database
    .query(
      "SELECT fingerprint, path, byte_length FROM execution_artifacts ORDER BY fingerprint, path",
    )
    .all() as ReadonlyArray<ArtifactRecord>;
};

const readSchemaVersion = (database: Database) => {
  const metadataTable = database
    .query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'system_metadata'",
    )
    .get() as { readonly present: number } | null;
  if (metadataTable === null) return 0;
  const metadata = database
    .query("SELECT value FROM system_metadata WHERE key = 'schema_version'")
    .get() as { readonly value: string } | null;
  const version = Number(metadata?.value ?? 0);
  return Number.isSafeInteger(version) && version >= 0 ? version : Number.NaN;
};

const inspectMigrations = (database: Database): ReadonlyArray<HomeDiagnostic> => {
  const table = database
    .query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'kojo_migrations'",
    )
    .get() as { readonly present: number } | null;
  if (table === null) return [];
  const applied = database
    .query("SELECT id, checksum FROM kojo_migrations ORDER BY id")
    .all() as ReadonlyArray<{ readonly checksum: string; readonly id: number }>;
  const diagnostics: Array<HomeDiagnostic> = [];
  for (const [index, migration] of applied.entries()) {
    const expected = kojoSchemaMigrations[index];
    if (expected === undefined) {
      diagnostics.push({
        code: "SCHEMA_VERSION_INCOMPATIBLE",
        message: `state.sqlite schema migration ${migration.id} is newer than this Kojo version.`,
      });
      break;
    }
    if (migration.id !== expected.id || migration.checksum !== expected.checksum) {
      diagnostics.push({
        code: "MIGRATION_FAILED",
        message:
          migration.id !== expected.id
            ? `state.sqlite migrations are not an ordered prefix; expected ${expected.id} but found ${migration.id}.`
            : `state.sqlite migration ${migration.id} checksum does not match.`,
      });
      break;
    }
  }
  return diagnostics;
};

const inspectDatabase = async (home: string, databasePath: string) => {
  const diagnostics: Array<HomeDiagnostic> = [];
  let database: Database;
  try {
    database = new Database(databasePath, { readonly: true, strict: true });
    const integrity = database.query("PRAGMA integrity_check").get() as {
      readonly integrity_check?: unknown;
    } | null;
    if (integrity?.integrity_check !== "ok") {
      diagnostics.push({
        code: "DATABASE_CORRUPT",
        message: "state.sqlite failed its full integrity check; restore a verified backup.",
      });
    }
  } catch (error) {
    return {
      artifacts: [] as ReadonlyArray<ArtifactRecord>,
      diagnostics: [
        {
          code: "DATABASE_CORRUPT" as const,
          message: `state.sqlite could not be read: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      schemaVersion: Number.NaN,
    };
  }

  try {
    const schemaVersion = readSchemaVersion(database);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion > kojoSchemaVersion) {
      diagnostics.push({
        code: "SCHEMA_VERSION_INCOMPATIBLE",
        message: Number.isSafeInteger(schemaVersion)
          ? `state.sqlite schema version ${String(schemaVersion)} is newer than supported version ${kojoSchemaVersion}.`
          : "state.sqlite schema version is invalid; restore a verified backup or repair the migration metadata.",
      });
    }
    diagnostics.push(...inspectMigrations(database));
    const artifacts = readArtifacts(database);
    for (const artifact of artifacts) {
      let artifactPath: string;
      try {
        artifactPath = resolveArtifactInside(home, artifact.path);
        await assertNoSymbolicLinkComponents(home, artifact.path);
      } catch (error) {
        diagnostics.push({
          code: "ARTIFACT_MISSING",
          message: error instanceof Error ? error.message : String(error),
          path: artifact.path,
        });
        continue;
      }
      try {
        const details = await lstat(artifactPath);
        if (!details.isFile()) throw new Error("not a regular file");
        const checksum = await checksumFile(artifactPath);
        if (checksum !== artifact.fingerprint || details.size !== artifact.byte_length) {
          diagnostics.push({
            code: "ARTIFACT_CHECKSUM_MISMATCH",
            message: `Execution Artifact ${artifact.path} does not match its durable fingerprint.`,
            path: artifact.path,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          diagnostics.push({
            code: "ARTIFACT_MISSING",
            message: `Referenced Execution Artifact ${artifact.path} is missing; runs that replay it cannot resume.`,
            path: artifact.path,
          });
        } else if (!diagnostics.some((diagnostic) => diagnostic.path === artifact.path)) {
          diagnostics.push({
            code: "ARTIFACT_CHECKSUM_MISMATCH",
            message: `Execution Artifact ${artifact.path} could not be verified: ${error instanceof Error ? error.message : String(error)}`,
            path: artifact.path,
          });
        }
      }
    }
    return { artifacts, diagnostics, schemaVersion };
  } finally {
    database.close();
  }
};

const assertMaintenanceLock = (home: string) => {
  if (!heldMaintenanceLocks.has(resolve(home))) {
    throw new Error(
      "Kojo Home maintenance requires the System Process to be stopped and its lock held",
    );
  }
};

export const withStoppedKojoHome = async <A>(home: string, operation: () => Promise<A>) => {
  const canonicalHome = resolve(home);
  await mkdir(canonicalHome, { mode: 0o700, recursive: true });
  await chmod(canonicalHome, 0o700);
  const lockPath = systemPaths(canonicalHome).lock;
  const token = randomUUID();
  const candidate = `${lockPath}.${process.pid}.${token}.maintenance`;
  const record = { phase: "starting", pid: process.pid, token } as const;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = await readLockRecord(canonicalHome).catch((error) => {
      throw new Error(
        `Kojo Home lock cannot be acquired for maintenance: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (owner !== undefined) {
      if (isProcessAlive(owner.pid)) {
        throw new Error(
          `Kojo Home is owned by System Process ${owner.pid}; stop it before maintenance`,
        );
      }
      await rm(lockPath, { force: true });
    }

    await writeFile(candidate, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    try {
      await link(candidate, lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 1) throw error;
    } finally {
      await rm(candidate, { force: true });
    }
  }

  heldMaintenanceLocks.set(canonicalHome, token);
  try {
    return await operation();
  } finally {
    heldMaintenanceLocks.delete(canonicalHome);
    const owner = await readLockRecord(canonicalHome).catch(() => undefined);
    if (owner?.token === token) await rm(lockPath, { force: true });
  }
};

export const backupKojoHome = async (home: string, destination: string) => {
  const canonicalHome = resolve(home);
  const canonicalDestination = resolve(destination);
  const destinationParent = dirname(canonicalDestination);
  await mkdir(destinationParent, { recursive: true });
  try {
    await lstat(canonicalDestination);
    throw new Error(`Backup destination already exists: ${canonicalDestination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const staging = join(destinationParent, `.kojo-backup-${randomUUID()}.staging`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const snapshotPath = join(staging, "state.sqlite");
    const source = new Database(join(canonicalHome, "state.sqlite"), {
      readonly: true,
      strict: true,
    });
    try {
      source.run(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    await chmod(snapshotPath, 0o600);

    const inspection = await inspectDatabase(staging, snapshotPath);
    const blocking = inspection.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "DATABASE_CORRUPT" || diagnostic.code === "SCHEMA_VERSION_INCOMPATIBLE",
    );
    if (blocking.length > 0) throw new Error(blocking.map(({ message }) => message).join(" "));

    const snapshot = new Database(snapshotPath, { readonly: true, strict: true });
    const artifacts = readArtifacts(snapshot);
    const schemaVersion = readSchemaVersion(snapshot);
    snapshot.close();
    const manifestArtifacts: Array<BackupManifestBody["artifacts"][number]> = [];
    for (const artifact of artifacts) {
      const sourcePath = resolveArtifactInside(canonicalHome, artifact.path);
      const destinationPath = resolveArtifactInside(staging, artifact.path);
      await assertNoSymbolicLinkComponents(canonicalHome, artifact.path);
      const details = await lstat(sourcePath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(
            `Referenced Execution Artifact ${artifact.path} is missing; backup stopped`,
          );
        }
        throw error;
      });
      if (!details.isFile()) throw new Error(`Execution Artifact ${artifact.path} is not a file`);
      const checksum = await checksumFile(sourcePath);
      if (checksum !== artifact.fingerprint || details.size !== artifact.byte_length) {
        throw new Error(
          `Execution Artifact ${artifact.path} does not match its durable fingerprint`,
        );
      }
      await mkdir(dirname(destinationPath), { mode: 0o700, recursive: true });
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o600);
      const copiedDetails = await lstat(destinationPath);
      const copiedChecksum = await checksumFile(destinationPath);
      if (
        !copiedDetails.isFile() ||
        copiedDetails.size !== artifact.byte_length ||
        copiedChecksum !== artifact.fingerprint
      ) {
        throw new Error(
          `Copied Execution Artifact ${artifact.path} does not match its durable fingerprint`,
        );
      }
      manifestArtifacts.push({
        byteLength: copiedDetails.size,
        fingerprint: artifact.fingerprint,
        path: artifact.path,
        sha256: copiedChecksum,
      });
    }

    const databaseDetails = await stat(snapshotPath);
    const body: BackupManifestBody = {
      artifacts: manifestArtifacts,
      createdAt: new Date().toISOString(),
      database: {
        byteLength: databaseDetails.size,
        path: "state.sqlite",
        sha256: await checksumFile(snapshotPath),
      },
      formatVersion: backupFormatVersion,
      schemaVersion,
    };
    const manifest: BackupManifest = {
      ...body,
      manifestChecksum: sha256(canonicalManifestBody(body)),
    };
    const manifestPath = join(staging, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await verifyBackup(staging);
    await rename(staging, canonicalDestination);
    return {
      artifactCount: manifestArtifacts.length,
      databaseChecksum: body.database.sha256,
      destination: canonicalDestination,
      manifestChecksum: manifest.manifestChecksum,
    };
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
};

const decodeManifest = async (backup: string): Promise<BackupManifest> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Backup manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = decoded as Partial<BackupManifest>;
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    manifest.formatVersion !== backupFormatVersion ||
    !Array.isArray(manifest.artifacts) ||
    !manifest.artifacts.every(
      (artifact) =>
        typeof artifact === "object" &&
        artifact !== null &&
        Number.isSafeInteger(artifact.byteLength) &&
        artifact.byteLength >= 0 &&
        typeof artifact.fingerprint === "string" &&
        artifact.fingerprint.length > 0 &&
        typeof artifact.path === "string" &&
        artifact.path.length > 0 &&
        typeof artifact.sha256 === "string" &&
        artifact.sha256.length > 0,
    ) ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.database !== "object" ||
    manifest.database === null ||
    manifest.database.path !== "state.sqlite" ||
    !Number.isSafeInteger(manifest.database.byteLength) ||
    manifest.database.byteLength < 0 ||
    typeof manifest.database?.sha256 !== "string" ||
    typeof manifest.manifestChecksum !== "string" ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    (manifest.schemaVersion ?? -1) < 0
  ) {
    throw new Error("Backup manifest is invalid or incompatible");
  }
  const validManifest = manifest as BackupManifest;
  const { manifestChecksum, ...body } = validManifest;
  if (sha256(canonicalManifestBody(body)) !== manifestChecksum) {
    throw new Error("Backup manifest checksum does not match its contents");
  }
  return validManifest;
};

export const verifyBackup = async (backup: string) => {
  const canonicalBackup = resolve(backup);
  const manifest = await decodeManifest(canonicalBackup);
  if (manifest.schemaVersion > kojoSchemaVersion) {
    throw new Error(
      `Backup schema version ${manifest.schemaVersion} is newer than supported version ${kojoSchemaVersion}`,
    );
  }
  const databasePath = resolveInside(canonicalBackup, manifest.database.path);
  await assertNoSymbolicLinkComponents(canonicalBackup, manifest.database.path);
  const databaseDetails = await lstat(databasePath);
  if (
    !databaseDetails.isFile() ||
    databaseDetails.size !== manifest.database.byteLength ||
    (await checksumFile(databasePath)) !== manifest.database.sha256
  ) {
    throw new Error("Backup state.sqlite checksum does not match the manifest");
  }
  for (const artifact of manifest.artifacts) {
    const path = resolveArtifactInside(canonicalBackup, artifact.path);
    await assertNoSymbolicLinkComponents(canonicalBackup, artifact.path);
    const details = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Backup Execution Artifact ${artifact.path} is missing`);
      }
      throw error;
    });
    if (
      !details.isFile() ||
      details.size !== artifact.byteLength ||
      (await checksumFile(path)) !== artifact.sha256 ||
      artifact.sha256 !== artifact.fingerprint
    ) {
      throw new Error(`Backup Execution Artifact ${artifact.path} checksum does not match`);
    }
  }
  const inspection = await inspectDatabase(canonicalBackup, databasePath);
  if (inspection.diagnostics.length > 0) {
    throw new Error(inspection.diagnostics.map(({ message }) => message).join(" "));
  }
  const referencedArtifacts = inspection.artifacts.map((artifact) => ({
    byteLength: artifact.byte_length,
    fingerprint: artifact.fingerprint,
    path: artifact.path,
  }));
  const manifestedArtifacts = manifest.artifacts.map(({ byteLength, fingerprint, path }) => ({
    byteLength,
    fingerprint,
    path,
  }));
  if (JSON.stringify(referencedArtifacts) !== JSON.stringify(manifestedArtifacts)) {
    throw new Error("Backup manifest does not match state.sqlite artifact references");
  }
  return {
    artifactCount: manifest.artifacts.length,
    manifestChecksum: manifest.manifestChecksum,
    schemaVersion: manifest.schemaVersion,
    status: "verified" as const,
  };
};

export const verifyKojoHome = async (home: string) => {
  assertMaintenanceLock(home);
  const inspection = await inspectDatabase(resolve(home), join(resolve(home), "state.sqlite"));
  return {
    artifactCount: inspection.artifacts.length,
    diagnostics: inspection.diagnostics,
    schemaVersion: inspection.schemaVersion,
    status: inspection.diagnostics.length === 0 ? ("verified" as const) : ("unavailable" as const),
  };
};

export const diagnoseKojoHomeStartup = async (home: string) => {
  const inspection = await inspectDatabase(resolve(home), join(resolve(home), "state.sqlite"));
  return inspection.diagnostics;
};

export const restoreKojoHome = async (home: string, backup: string) => {
  assertMaintenanceLock(home);
  const canonicalHome = resolve(home);
  const canonicalBackup = resolve(backup);
  const verified = await verifyBackup(canonicalBackup);
  const manifest = await decodeManifest(canonicalBackup);
  if (manifest.manifestChecksum !== verified.manifestChecksum) {
    throw new Error("Backup manifest changed while restore was preparing");
  }

  for (const artifact of manifest.artifacts) {
    const sourcePath = resolveArtifactInside(canonicalBackup, artifact.path);
    const destinationPath = resolveArtifactInside(canonicalHome, artifact.path);
    await assertNoSymbolicLinkComponents(canonicalBackup, artifact.path);
    await assertNoSymbolicLinkComponents(canonicalHome, artifact.path, { allowFinal: true });
    await mkdir(dirname(destinationPath), { mode: 0o700, recursive: true });
    const existingDetails = await lstat(destinationPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const existingChecksum = existingDetails?.isFile()
      ? await checksumFile(destinationPath)
      : undefined;
    if (existingChecksum !== artifact.sha256) {
      const staging = `${destinationPath}.${randomUUID()}.restore`;
      try {
        await copyFile(sourcePath, staging);
        await chmod(staging, 0o600);
        const stagedDetails = await lstat(staging);
        if (
          !stagedDetails.isFile() ||
          stagedDetails.size !== artifact.byteLength ||
          (await checksumFile(staging)) !== artifact.sha256
        ) {
          throw new Error(`Restored Execution Artifact ${artifact.path} checksum does not match`);
        }
        await rename(staging, destinationPath);
      } finally {
        await rm(staging, { force: true });
      }
    }
  }

  const databasePath = join(canonicalHome, "state.sqlite");
  const stagedDatabase = join(canonicalHome, `.state.${randomUUID()}.restore.sqlite`);
  const previousDatabase = join(
    canonicalHome,
    `state.before-restore-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.sqlite`,
  );
  try {
    await copyFile(join(canonicalBackup, "state.sqlite"), stagedDatabase);
    await chmod(stagedDatabase, 0o600);
    const stagedDetails = await stat(stagedDatabase);
    if (
      stagedDetails.size !== manifest.database.byteLength ||
      (await checksumFile(stagedDatabase)) !== manifest.database.sha256
    ) {
      throw new Error("Restored state.sqlite checksum does not match the manifest");
    }
    try {
      await link(databasePath, previousDatabase);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rename(stagedDatabase, databasePath);
  } finally {
    await rm(stagedDatabase, { force: true });
  }
  return { ...verified, previousDatabase, status: "restored" as const };
};

const removeStagingContents = async (path: string): Promise<number> => {
  let entries: Array<Dirent>;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let files = 0;
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) files += await removeStagingContents(entryPath);
    else files += 1;
    await rm(entryPath, { force: true, recursive: entry.isDirectory() });
  }
  return files;
};

export const compactKojoHome = async (home: string) => {
  assertMaintenanceLock(home);
  const verification = await verifyKojoHome(home);
  const unsafeDatabase = verification.diagnostics.filter(({ code }) =>
    ["DATABASE_CORRUPT", "MIGRATION_FAILED", "SCHEMA_VERSION_INCOMPATIBLE"].includes(code),
  );
  if (unsafeDatabase.length > 0) {
    throw new Error(
      `${unsafeDatabase.map(({ message }) => message).join(" ")} Compaction stopped without modifying state.sqlite.`,
    );
  }
  const database = new Database(join(resolve(home), "state.sqlite"), { strict: true });
  try {
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    database.run("VACUUM");
  } finally {
    database.close();
  }
  return {
    cleanedStagingFiles: await removeStagingContents(join(resolve(home), "artifacts", "staging")),
    status: "compacted" as const,
  };
};

export const repairKojoHomeMigrations = async (home: string) => {
  assertMaintenanceLock(home);
  const store = await openSystemStore(resolve(home));
  store.close();
  const verification = await verifyKojoHome(home);
  if (verification.status !== "verified") {
    throw new Error(verification.diagnostics.map(({ message }) => message).join(" "));
  }
  return { schemaVersion: verification.schemaVersion, status: "repaired" as const };
};
