import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeProjectStoreMigration,
  migrateProjectStore,
} from "../../../../../src/adapters/projects/drizzle-project-store";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Drizzle Project store recovery", () => {
  it("never follows a live database symlink while a migration backup is pending", async () => {
    const fixture = await initializedProject("kojo-store-recovery-symlink-");
    const backupPath = `${fixture.databasePath}.migration-backup`;
    vacuumInto(fixture.databasePath, backupPath);
    await chmod(backupPath, 0o600);
    const outsidePath = join(fixture.directory, "outside.sqlite");
    await writeFile(outsidePath, "outside must remain unchanged");
    const outsideBefore = await readFile(outsidePath);
    await unlink(fixture.databasePath);
    await symlink(outsidePath, fixture.databasePath);

    expect(() => migrateProjectStore(fixture.project)).toThrow("unsafe Project database");
    expect(await readFile(outsidePath)).toEqual(outsideBefore);
    expect(await Bun.file(backupPath).exists()).toBe(true);
  });

  it("restores a verified backup without replaying stale WAL frames from a crashed writer", async () => {
    const fixture = await initializedProject("kojo-store-recovery-wal-");
    const backupPath = `${fixture.databasePath}.migration-backup`;
    vacuumInto(fixture.databasePath, backupPath);
    await chmod(backupPath, 0o600);
    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Database } from "bun:sqlite"; const db = new Database(${JSON.stringify(fixture.databasePath)}); db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO kojo_retention_policy(singleton_key,row_version,updated_at_ms) VALUES (1,1,1)"); process.exit(0);`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await writer.exited).toBe(0);
    expect(await Bun.file(`${fixture.databasePath}-wal`).exists()).toBe(true);

    migrateProjectStore(fixture.project);
    expect(completeProjectStoreMigration(fixture.project, true)).toBe(true);

    const restored = new Database(fixture.databasePath, { readonly: true });
    expect(restored.query("SELECT * FROM kojo_retention_policy").all()).toEqual([]);
    restored.close();
    expect(await Bun.file(backupPath).exists()).toBe(false);
  });

  it("enforces authoritative SHA widths and migration foreign keys", async () => {
    const fixture = await initializedProject("kojo-store-schema-constraints-");
    const database = new Database(fixture.databasePath);
    database.exec("PRAGMA foreign_keys = ON");

    expect(() =>
      database
        .query(
          "INSERT INTO kojo_control_requests(request_key, operation_kind, request_sha256, target_kind, state, created_at_ms) VALUES ('short-hash', 'test', zeroblob(31), 'none', 'pending', 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .query(
          "INSERT INTO kojo_control_requests(request_key, operation_kind, request_sha256, target_kind, target_schedule_key, state, created_at_ms) VALUES ('missing-schedule', 'test', zeroblob(32), 'schedule', 'missing', 'pending', 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .query(
          "INSERT INTO kojo_control_requests(request_key, operation_kind, request_sha256, target_kind, state, created_at_ms) VALUES ('missing-run-target', 'test', zeroblob(32), 'run', 'pending', 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .query(
          "INSERT INTO kojo_control_requests(request_key, operation_kind, request_sha256, target_kind, state, created_at_ms, completed_at_ms) VALUES ('incomplete-result', 'test', zeroblob(32), 'none', 'completed', 1, 2)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .query(
          "INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, schedule_key, scheduled_at_ms, schedule_revision, state, row_version, accepted_at_ms, updated_at_ms) VALUES ('bad-trigger', 'start-bad', zeroblob(32), 'workflow', 'revision', 1, '{}', zeroblob(32), 'manual', 'schedule', 1, 'revision', 'running', 1, 1, 1)",
        )
        .run(),
    ).toThrow();

    database.exec(
      "INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, state, row_version, accepted_at_ms, updated_at_ms) VALUES ('run', 'start', zeroblob(32), 'workflow', 'revision', 1, '{}', randomblob(32), 'manual', 'running', 1, 1, 1)",
    );
    expect(() =>
      database
        .query(
          "INSERT INTO kojo_engine_operations(operation_id, run_id, kind, operation_key, request_encoding_version, request_schema_identity, request_json, request_sensitivity_map_version, request_sensitivity_map_json, request_sha256, state, attempt_count, created_at_ms, updated_at_ms) VALUES ('operation', 'run', 'submit', 'key', 1, 'schema', '{}', 1, '{}', zeroblob(32), 'confirmed', 1, 1, 1)",
        )
        .run(),
    ).toThrow();

    database.exec(
      "INSERT INTO kojo_workflow_schedule_states(schedule_key, enabled_intent, condition, row_version, created_at_ms, updated_at_ms) VALUES ('schedule', 0, 'unavailable', 1, 1, 1)",
    );
    expect(() =>
      database
        .query(
          "INSERT INTO kojo_workflow_schedule_occurrences(schedule_key, scheduled_at_ms, applied_revision, resolved_input_encoding_version, resolved_input_schema_identity, resolved_input_json, resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json, resolved_input_sha256, outcome, delivery_attempt_count, planned_at_ms, processed_at_ms, row_version) VALUES ('schedule', 2, 'revision', 1, 'schema', '{}', 1, '{}', zeroblob(32), 'planned', 0, 1, 2, 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .query(
          "INSERT INTO kojo_retention_policy(singleton_key, row_version, updated_at_ms) VALUES (1, 0, -1)",
        )
        .run(),
    ).toThrow();
    database.close();
  });
});

const initializedProject = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true }));
  const projectPath = join(directory, "project");
  const dataPath = join(projectPath, ".kojo");
  await mkdir(dataPath, { recursive: true, mode: 0o700 });
  const identity = Bun.randomUUIDv7();
  const metadataPath = join(dataPath, "project.json");
  await writeFile(
    metadataPath,
    `${JSON.stringify({ layoutVersion: 1, projectIdentity: identity })}\n`,
    { mode: 0o600 },
  );
  await chmod(metadataPath, 0o600);
  const databasePath = join(dataPath, "kojo.sqlite");
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec(`CREATE TABLE kojo_project_store_identity (
    singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
    project_identity TEXT NOT NULL UNIQUE,
    database_instance_id TEXT NOT NULL UNIQUE
  ) STRICT`);
  database
    .query("INSERT INTO kojo_project_store_identity VALUES (1, ?, ?)")
    .run(identity, randomUUID());
  database.exec("PRAGMA user_version = 0");
  database.close();
  await chmod(databasePath, 0o600);
  const project = { identity, path: projectPath };
  migrateProjectStore(project);
  expect(completeProjectStoreMigration(project, true)).toBe(true);
  return {
    directory,
    databasePath,
    project,
  };
};

const vacuumInto = (sourcePath: string, destinationPath: string) => {
  const source = new Database(sourcePath, { readonly: true });
  source.query("VACUUM INTO ?").run(destinationPath);
  source.close();
};
