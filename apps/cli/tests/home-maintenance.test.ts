import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  backupKojoHome,
  compactKojoHome,
  diagnoseKojoHomeStartup,
  restoreKojoHome,
  verifyBackup,
  verifyKojoHome,
  withStoppedKojoHome,
} from "../src/system/home-maintenance";
import { openSystemStore } from "../src/system/storage";

const temporaryPaths: Array<string> = [];

const makeTemporaryDirectory = async (name: string) => {
  const path = await Bun.$`mktemp -d ${`/tmp/kojo-${name}-XXXXXX`}`.text();
  const trimmed = path.trim();
  temporaryPaths.push(trimmed);
  return trimmed;
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("Kojo Home maintenance", () => {
  test("creates one online checksummed snapshot with every referenced immutable artifact", async () => {
    const home = await makeTemporaryDirectory("backup-home");
    const destination = join(await makeTemporaryDirectory("backup-parent"), "snapshot");
    const store = await openSystemStore(home);
    const artifact = Buffer.from("durable evidence\n");
    const fingerprint = sha256(artifact);
    const artifactPath = join("artifacts", fingerprint);
    await mkdir(join(home, "artifacts"), { recursive: true });
    await writeFile(join(home, artifactPath), artifact);
    const database = new Database(join(home, "state.sqlite"));
    database.run(
      "INSERT INTO execution_artifacts (fingerprint, path, media_type, byte_length, created_at) VALUES (?, ?, ?, ?, ?)",
      [fingerprint, artifactPath, "text/plain", artifact.byteLength, new Date().toISOString()],
    );
    database.close();

    try {
      const result = await backupKojoHome(home, destination);

      expect(result.artifactCount).toBe(1);
      expect(result.databaseChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(join(destination, artifactPath), "utf8")).toBe("durable evidence\n");
      expect((await verifyBackup(destination)).status).toBe("verified");
      expect((await stat(join(destination, "manifest.json"))).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  test("rejects manifest mismatches and restores only a fully verified backup", async () => {
    const home = await makeTemporaryDirectory("restore-home");
    const destination = join(await makeTemporaryDirectory("restore-backup"), "snapshot");
    const store = await openSystemStore(home);
    store.close();
    const original = new Database(join(home, "state.sqlite"));
    original.run("INSERT INTO system_metadata (key, value) VALUES ('proof', 'before')");
    original.close();
    await backupKojoHome(home, destination);

    const changed = new Database(join(home, "state.sqlite"));
    changed.run("UPDATE system_metadata SET value = 'after' WHERE key = 'proof'");
    changed.close();
    await withStoppedKojoHome(home, () => restoreKojoHome(home, destination));

    const restored = new Database(join(home, "state.sqlite"), { readonly: true });
    expect(restored.query("SELECT value FROM system_metadata WHERE key = 'proof'").get()).toEqual({
      value: "before",
    });
    restored.close();

    await writeFile(join(destination, "state.sqlite"), "tampered");
    await expect(verifyBackup(destination)).rejects.toThrow("checksum");
    await expect(
      withStoppedKojoHome(home, () => restoreKojoHome(home, destination)),
    ).rejects.toThrow("checksum");
  });

  test("replaces an artifact symlink instead of restoring outside Kojo Home", async () => {
    const home = await makeTemporaryDirectory("restore-symlink-home");
    const destination = join(await makeTemporaryDirectory("restore-symlink-backup"), "snapshot");
    const outside = join(await makeTemporaryDirectory("restore-symlink-outside"), "artifact");
    const store = await openSystemStore(home);
    const artifact = Buffer.from("immutable artifact\n");
    const fingerprint = sha256(artifact);
    const artifactPath = join("artifacts", fingerprint);
    await mkdir(join(home, "artifacts"), { recursive: true });
    await writeFile(join(home, artifactPath), artifact);
    const database = new Database(join(home, "state.sqlite"));
    database.run(
      "INSERT INTO execution_artifacts (fingerprint, path, media_type, byte_length, created_at) VALUES (?, ?, ?, ?, ?)",
      [fingerprint, artifactPath, "text/plain", artifact.byteLength, new Date().toISOString()],
    );
    database.close();
    await backupKojoHome(home, destination);
    store.close();
    await rm(join(home, artifactPath));
    await writeFile(outside, artifact);
    await symlink(outside, join(home, artifactPath));

    await withStoppedKojoHome(home, () => restoreKojoHome(home, destination));

    expect((await lstat(join(home, artifactPath))).isFile()).toBe(true);
    expect(await readFile(join(home, artifactPath), "utf8")).toBe("immutable artifact\n");
    expect(await readFile(outside, "utf8")).toBe("immutable artifact\n");
  });

  test("requires stopped lock authority for destructive maintenance and preserves canonical history", async () => {
    const home = await makeTemporaryDirectory("verify-home");
    const store = await openSystemStore(home);
    store.close();
    await mkdir(join(home, "artifacts", "staging"), { recursive: true });
    await writeFile(join(home, "artifacts", "staging", "abandoned.tmp"), "partial");

    await expect(compactKojoHome(home)).rejects.toThrow("lock");

    const result = await withStoppedKojoHome(home, async () => {
      const verification = await verifyKojoHome(home);
      const compacted = await compactKojoHome(home);
      return { compacted, verification };
    });

    expect(result.verification.status).toBe("verified");
    expect(result.compacted.cleanedStagingFiles).toBe(1);
    const database = new Database(join(home, "state.sqlite"), { readonly: true });
    expect(database.query("SELECT count(*) AS count FROM evidence_events").get()).toEqual({
      count: 0,
    });
    database.close();
  });

  test("reports missing referenced artifacts without replacing the database", async () => {
    const home = await makeTemporaryDirectory("missing-artifact-home");
    const store = await openSystemStore(home);
    store.close();
    const databasePath = join(home, "state.sqlite");
    const database = new Database(databasePath);
    database.run(
      "INSERT INTO execution_artifacts (fingerprint, path, media_type, byte_length, created_at) VALUES ('missing', 'artifacts/missing', 'text/plain', 4, 'now')",
    );
    database.close();
    const before = sha256(await readFile(databasePath));

    const verification = await withStoppedKojoHome(home, () => verifyKojoHome(home));

    expect(verification.status).toBe("unavailable");
    expect(verification.diagnostics).toEqual([
      expect.objectContaining({ code: "ARTIFACT_MISSING", path: "artifacts/missing" }),
    ]);
    expect(sha256(await readFile(databasePath))).toBe(before);
    expect(await diagnoseKojoHomeStartup(home)).toEqual([
      expect.objectContaining({ code: "ARTIFACT_MISSING", path: "artifacts/missing" }),
    ]);
  });

  test("rejects artifact references that collide with Kojo Home authority files", async () => {
    const home = await makeTemporaryDirectory("unsafe-artifact-home");
    const destination = join(await makeTemporaryDirectory("unsafe-artifact-backup"), "snapshot");
    const store = await openSystemStore(home);
    store.close();
    const database = new Database(join(home, "state.sqlite"));
    database.run(
      "INSERT INTO execution_artifacts (fingerprint, path, media_type, byte_length, created_at) VALUES ('unsafe', 'state.sqlite', 'application/octet-stream', 0, 'now')",
    );
    database.close();

    await expect(backupKojoHome(home, destination)).rejects.toThrow("finalized artifact store");
    expect(await diagnoseKojoHomeStartup(home)).toEqual([
      expect.objectContaining({ code: "ARTIFACT_MISSING", path: "state.sqlite" }),
    ]);
  });

  test("creates a complete backup before an irreversible migration", async () => {
    const home = await makeTemporaryDirectory("migration-backup-home");
    const initialized = await openSystemStore(home);
    initialized.close();
    const database = new Database(join(home, "state.sqlite"));
    database.run("DROP TABLE workflow_revision_snapshots");
    database.run("DELETE FROM kojo_migrations WHERE id = 5");
    database.run("UPDATE system_metadata SET value = '4' WHERE key = 'schema_version'");
    database.close();

    const migrated = await openSystemStore(home);
    migrated.close();

    const backups = await readdir(join(home, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toStartWith("before-migration-5-");
    expect((await verifyBackup(join(home, "backups", backups[0] ?? ""))).schemaVersion).toBe(4);
  });

  test("refuses a newer schema without rewriting or compacting it", async () => {
    const home = await makeTemporaryDirectory("newer-schema-home");
    const initialized = await openSystemStore(home);
    initialized.close();
    const databasePath = join(home, "state.sqlite");
    const database = new Database(databasePath);
    database.run("UPDATE system_metadata SET value = '999' WHERE key = 'schema_version'");
    database.close();
    const before = sha256(await readFile(databasePath));

    await expect(openSystemStore(home)).rejects.toThrow("newer than supported version");
    await expect(withStoppedKojoHome(home, () => compactKojoHome(home))).rejects.toThrow(
      "Compaction stopped without modifying",
    );

    const unchanged = new Database(databasePath, { readonly: true });
    expect(
      unchanged.query("SELECT value FROM system_metadata WHERE key = 'schema_version'").get(),
    ).toEqual({ value: "999" });
    unchanged.close();
    expect(sha256(await readFile(databasePath))).toBe(before);
  });

  test("refuses maintenance while a live System Process lock exists", async () => {
    const home = await makeTemporaryDirectory("locked-home");
    await chmod(home, 0o700);
    await writeFile(
      join(home, "system.lock"),
      JSON.stringify({ phase: "starting", pid: process.pid, token: "system" }),
      { mode: 0o600 },
    );

    await expect(withStoppedKojoHome(home, () => Promise.resolve())).rejects.toThrow(
      "System Process",
    );
  });
});
