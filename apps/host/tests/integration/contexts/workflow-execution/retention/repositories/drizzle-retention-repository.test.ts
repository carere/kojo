import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import { ProjectIdentity, type ProjectRetentionSetInput, RequestKey } from "@kojo/control";
import { Effect, Schema } from "effect";
import {
  completeProjectRepositoryMigration,
  migrateProjectRepository,
} from "../../../../../../src/contexts/workflow-execution/projects/repositories/drizzle-project-repository";
import { makeDrizzleRetentionRepository } from "../../../../../../src/contexts/workflow-execution/retention/repositories/drizzle-retention-repository";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it.effect("removes only final disposable Artifact bytes and preserves authoritative history", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => initializedProject("kojo-retention-final-"));
    const runId = Bun.randomUUIDv7();
    const artifactId = Bun.randomUUIDv7();
    const artifactPath = join(
      fixture.project.path,
      ".kojo",
      "artifacts",
      runId,
      `${artifactId}.json`,
    );
    yield* Effect.promise(() =>
      mkdir(join(fixture.project.path, ".kojo", "artifacts", runId), { recursive: true }),
    );
    yield* Effect.promise(() => writeFile(artifactPath, "final disposable bytes", { mode: 0o600 }));
    yield* Effect.sync(() => insertCompletedRun(fixture.databasePath, runId, artifactId));

    const requestKey = Schema.decodeUnknownSync(RequestKey)("retention-set-final");
    const repository = makeDrizzleRetentionRepository();
    const input = {
      identity: fixture.project.identity,
      requestKey,
      disposableMaxAgeMs: 1,
      disposableMaxBytes: 1,
    } satisfies ProjectRetentionSetInput;
    const set = yield* repository.set(fixture.project, input);
    expect(set._tag).toBe("success");

    const cleaned = yield* repository.cleanup(fixture.project, 100);
    expect(cleaned.usage.expiredArtifactCount).toBe(1);
    expect(cleaned.usage.availableArtifactCount).toBe(0);
    expect(cleaned.usage.missingArtifactCount).toBe(0);
    expect(yield* Effect.promise(() => readFile(fixture.databasePath))).toBeInstanceOf(Uint8Array);
    expect(yield* Effect.promise(() => Bun.file(artifactPath).exists())).toBe(false);

    const database = new Database(fixture.databasePath, { readonly: true, strict: true });
    expect(
      database.query("SELECT state FROM kojo_workflow_runs WHERE run_id = ?").get(runId),
    ).toEqual({
      state: "completed",
    });
    expect(
      database
        .query("SELECT COUNT(*) AS count FROM kojo_execution_events WHERE run_id = ?")
        .get(runId),
    ).toEqual({
      count: 2,
    });
    expect(
      database
        .query("SELECT condition FROM kojo_execution_artifacts WHERE artifact_id = ?")
        .get(artifactId),
    ).toEqual({
      condition: "expired",
    });
    database.close();

    const repeated = yield* repository.cleanup(fixture.project, 100);
    expect(repeated.usage.expiredArtifactCount).toBe(1);
  }),
);

it.effect("keeps non-final content protected and reports missing retained bytes", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => initializedProject("kojo-retention-protected-"));
    const runningRunId = Bun.randomUUIDv7();
    const runningArtifactId = Bun.randomUUIDv7();
    const missingRunId = Bun.randomUUIDv7();
    const missingArtifactId = Bun.randomUUIDv7();
    yield* Effect.sync(() => {
      insertRunningRun(fixture.databasePath, runningRunId, runningArtifactId);
      insertCompletedRun(fixture.databasePath, missingRunId, missingArtifactId);
    });
    const runningPath = join(
      fixture.project.path,
      ".kojo",
      "artifacts",
      runningRunId,
      `${runningArtifactId}.json`,
    );
    yield* Effect.promise(() =>
      mkdir(join(fixture.project.path, ".kojo", "artifacts", runningRunId), { recursive: true }),
    );
    yield* Effect.promise(() => writeFile(runningPath, "protected", { mode: 0o600 }));

    const repository = makeDrizzleRetentionRepository();
    const requestKey = Schema.decodeUnknownSync(RequestKey)("retention-set-protected");
    yield* repository.set(fixture.project, {
      identity: fixture.project.identity,
      requestKey,
      disposableMaxAgeMs: 1,
      disposableMaxBytes: 1,
    });
    const cleaned = yield* repository.cleanup(fixture.project, 100);

    expect(cleaned.warnings.map(({ code }) => code)).toEqual([
      "protected-over-limit",
      "missing-retained-content",
    ]);
    expect(yield* Effect.promise(() => Bun.file(runningPath).exists())).toBe(true);
  }),
);

it.effect("protects Agent continuation and Sandbox state until Run finality", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => initializedProject("kojo-retention-continuation-"));
    const runningRunId = Bun.randomUUIDv7();
    const runningArtifactId = Bun.randomUUIDv7();
    const finalRunId = Bun.randomUUIDv7();
    const finalArtifactId = Bun.randomUUIDv7();
    yield* Effect.sync(() => {
      insertRunningRun(fixture.databasePath, runningRunId, runningArtifactId);
      insertCompletedRun(fixture.databasePath, finalRunId, finalArtifactId);
    });

    for (const rootName of ["sandboxes", "transcripts", "sessions", "agent-sessions"]) {
      for (const runId of [runningRunId, finalRunId]) {
        const directory = join(fixture.project.path, ".kojo", rootName, runId);
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(join(directory, "session.bin"), `${rootName}-${runId}`),
        );
      }
    }
    for (const [runId, artifactId] of [
      [runningRunId, runningArtifactId],
      [finalRunId, finalArtifactId],
    ] as const) {
      const directory = join(fixture.project.path, ".kojo", "artifacts", runId);
      yield* Effect.promise(() => mkdir(directory, { recursive: true }));
      yield* Effect.promise(() => writeFile(join(directory, `${artifactId}.json`), "artifact"));
    }

    const repository = makeDrizzleRetentionRepository();
    yield* repository.set(fixture.project, {
      identity: fixture.project.identity,
      requestKey: Schema.decodeUnknownSync(RequestKey)("retention-set-continuation"),
      disposableMaxAgeMs: 1,
      disposableMaxBytes: 1,
    });
    const cleaned = yield* repository.cleanup(fixture.project, 100);

    expect(cleaned.usage.protectedDisposableBytes).toBeGreaterThan(0);
    for (const rootName of ["sandboxes", "transcripts", "sessions", "agent-sessions"]) {
      expect(
        yield* Effect.promise(() =>
          Bun.file(
            join(fixture.project.path, ".kojo", rootName, runningRunId, "session.bin"),
          ).exists(),
        ),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          Bun.file(
            join(fixture.project.path, ".kojo", rootName, finalRunId, "session.bin"),
          ).exists(),
        ),
      ).toBe(false);
    }
  }),
);

it.effect("discovers final and active run directories without Artifact rows", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => initializedProject("kojo-retention-no-artifact-"));
    const activeRunId = Bun.randomUUIDv7();
    const finalRunId = Bun.randomUUIDv7();
    yield* Effect.sync(() => {
      insertRunWithoutArtifact(fixture.databasePath, activeRunId, "running");
      insertRunWithoutArtifact(fixture.databasePath, finalRunId, "completed");
    });

    for (const rootName of ["sandboxes", "agent-sessions"] as const) {
      for (const runId of [activeRunId, finalRunId]) {
        const directory = join(fixture.project.path, ".kojo", rootName, runId);
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(join(directory, "state.bin"), `${rootName}-${runId}`),
        );
      }
    }

    const repository = makeDrizzleRetentionRepository();
    yield* repository.set(fixture.project, {
      identity: fixture.project.identity,
      requestKey: Schema.decodeUnknownSync(RequestKey)("retention-set-no-artifact"),
      disposableMaxAgeMs: 1,
      disposableMaxBytes: 1,
    });
    const cleaned = yield* repository.cleanup(fixture.project, 100);

    expect(cleaned.usage.protectedDisposableBytes).toBeGreaterThan(0);
    for (const rootName of ["sandboxes", "agent-sessions"] as const) {
      expect(
        yield* Effect.promise(() =>
          Bun.file(
            join(fixture.project.path, ".kojo", rootName, activeRunId, "state.bin"),
          ).exists(),
        ),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          Bun.file(join(fixture.project.path, ".kojo", rootName, finalRunId, "state.bin")).exists(),
        ),
      ).toBe(false);
    }
  }),
);

it.effect("never removes authoritative schedules, Runs, engine, Activity, or Event data", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() =>
      initializedProject("kojo-retention-authoritative-"),
    );
    const runId = Bun.randomUUIDv7();
    const artifactId = Bun.randomUUIDv7();
    yield* Effect.sync(() => {
      insertRunningRun(fixture.databasePath, runId, artifactId);
      const database = new Database(fixture.databasePath);
      database.exec(`
        INSERT INTO kojo_workflow_schedule_states(
          schedule_key, enabled_intent, condition, row_version, created_at_ms, updated_at_ms
        ) VALUES ('retention-schedule', 1, 'available', 1, 0, 0);
        INSERT INTO kojo_workflow_schedule_occurrences(
          schedule_key, scheduled_at_ms, applied_revision, resolved_input_encoding_version,
          resolved_input_schema_identity, resolved_input_json, resolved_input_sensitivity_map_version,
          resolved_input_sensitivity_map_json, resolved_input_sha256, outcome, delivery_attempt_count,
          planned_at_ms, row_version
        ) VALUES ('retention-schedule', 0, 'revision', 1, 'schema', '{}', 1, '{}', zeroblob(32),
          'planned', 0, 0, 1);
        INSERT INTO kojo_engine_operations(
          operation_id, run_id, kind, operation_key, request_encoding_version,
          request_schema_identity, request_json, request_sensitivity_map_version,
          request_sensitivity_map_json, request_sha256, state, attempt_count,
          created_at_ms, updated_at_ms
        ) VALUES ('retention-operation', '${runId}', 'submit', 'submit', 1, 'schema', '{}', 1,
          '{}', zeroblob(32), 'pending', 0, 0, 0);
        INSERT INTO kojo_workflow_activity_operations(
          run_id, durable_operation_key, activity_name, definition_fingerprint,
          execution_generation, prepared_at_ms
        ) VALUES ('${runId}', 'activity', 'publish', 'publish-v1', 1, 0);
        INSERT INTO kojo_workflow_activity_attempts(
          attempt_id, run_id, durable_operation_key, activity_name, execution_generation,
          effect_retry_number, invocation_number, activity_idempotency_key, state, started_at_ms
        ) VALUES ('retention-attempt', '${runId}', 'activity', 'publish', 1, 0, 1,
          'publish:one', 'started', 0);
      `);
      database.close();
    });
    const artifactPath = join(
      fixture.project.path,
      ".kojo",
      "artifacts",
      runId,
      `${artifactId}.json`,
    );
    yield* Effect.promise(() =>
      mkdir(join(fixture.project.path, ".kojo", "artifacts", runId), { recursive: true }),
    );
    yield* Effect.promise(() => writeFile(artifactPath, "protected"));

    const authoritativeTables = [
      "kojo_workflow_schedule_states",
      "kojo_workflow_schedule_occurrences",
      "kojo_workflow_runs",
      "kojo_engine_operations",
      "kojo_workflow_activity_operations",
      "kojo_workflow_activity_attempts",
      "kojo_execution_events",
    ];
    const counts = (database: Database) =>
      authoritativeTables.map(
        (table) =>
          (database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
            .count,
      );
    const before = new Database(fixture.databasePath, { readonly: true, strict: true });
    const beforeCounts = counts(before);
    before.close();

    const repository = makeDrizzleRetentionRepository();
    yield* repository.set(fixture.project, {
      identity: fixture.project.identity,
      requestKey: Schema.decodeUnknownSync(RequestKey)("retention-set-authoritative"),
      disposableMaxAgeMs: 1,
      disposableMaxBytes: 1,
    });
    yield* repository.cleanup(fixture.project, 100);

    const after = new Database(fixture.databasePath, { readonly: true, strict: true });
    expect(counts(after)).toEqual(beforeCounts);
    expect(after.query("SELECT state FROM kojo_workflow_runs WHERE run_id = ?").get(runId)).toEqual(
      {
        state: "running",
      },
    );
    expect(
      after
        .query(
          "SELECT state FROM kojo_engine_operations WHERE operation_id = 'retention-operation'",
        )
        .get(),
    ).toEqual({
      state: "pending",
    });
    after.close();
  }),
);

const initializedProject = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true }));
  const projectPath = join(directory, "project");
  const dataPath = join(projectPath, ".kojo");
  await mkdir(dataPath, { recursive: true, mode: 0o700 });
  const identity = Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7());
  const metadataPath = join(dataPath, "project.json");
  await writeFile(
    metadataPath,
    `${JSON.stringify({ layoutVersion: 1, projectIdentity: identity })}\n`,
    {
      mode: 0o600,
    },
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
  migrateProjectRepository(project);
  if (!completeProjectRepositoryMigration(project, true)) throw new Error("migration failed");
  return { databasePath, project };
};

const insertCompletedRun = (databasePath: string, runId: string, artifactId: string) => {
  const database = new Database(databasePath);
  database
    .query(
      `INSERT INTO kojo_workflow_runs(
         run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
         engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind,
         state, outcome_event_id, last_event_sequence, row_version, accepted_at_ms,
         updated_at_ms, finalized_at_ms
       ) VALUES (?, ?, zeroblob(32), 'workflow', 'revision', 1, '{}', randomblob(32), 'manual',
         'completed', ?, 2, 1, 0, 2, 0)`,
    )
    .run(runId, `start-${runId}`, `outcome-${runId}`);
  insertEvent(database, runId, "accepted", 1, "run.accepted", 0);
  insertEvent(database, runId, `outcome-${runId}`, 2, "run.completed", 0);
  database
    .query(
      `INSERT INTO kojo_execution_artifacts(
         artifact_id, run_id, storage_key, display_name, media_type, byte_size, sha256,
         condition, created_at_ms
       ) VALUES (?, ?, ?, 'final', 'application/json', 22, zeroblob(32), 'available', 0)`,
    )
    .run(artifactId, runId, `${runId}/${artifactId}.json`);
  database.close();
};

const insertRunningRun = (databasePath: string, runId: string, artifactId: string) => {
  const database = new Database(databasePath);
  database
    .query(
      `INSERT INTO kojo_workflow_runs(
         run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
         engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind,
         state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms
       ) VALUES (?, ?, zeroblob(32), 'workflow', 'revision', 1, '{}', randomblob(32), 'manual',
         'running', 1, 1, 0, 2)`,
    )
    .run(runId, `start-${runId}`);
  insertEvent(database, runId, `accepted-${runId}`, 1, "run.accepted", 0);
  database
    .query(
      `INSERT INTO kojo_execution_artifacts(
         artifact_id, run_id, storage_key, display_name, media_type, byte_size, sha256,
         condition, created_at_ms
       ) VALUES (?, ?, ?, 'running', 'application/json', 9, zeroblob(32), 'available', 0)`,
    )
    .run(artifactId, runId, `${runId}/${artifactId}.json`);
  database.close();
};

const insertRunWithoutArtifact = (
  databasePath: string,
  runId: string,
  state: "running" | "completed",
) => {
  const database = new Database(databasePath);
  if (state === "completed") {
    database
      .query(
        `INSERT INTO kojo_workflow_runs(
           run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
           engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind,
           state, outcome_event_id, last_event_sequence, row_version, accepted_at_ms,
           updated_at_ms, finalized_at_ms
         ) VALUES (?, ?, zeroblob(32), 'workflow', 'revision', 1, '{}', randomblob(32), 'manual',
           'completed', ?, 2, 1, 0, 2, 0)`,
      )
      .run(runId, `start-${runId}`, `outcome-${runId}`);
    insertEvent(database, runId, `accepted-${runId}`, 1, "run.accepted", 0);
    insertEvent(database, runId, `outcome-${runId}`, 2, "run.completed", 0);
  } else {
    database
      .query(
        `INSERT INTO kojo_workflow_runs(
           run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
           engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind,
           state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms
         ) VALUES (?, ?, zeroblob(32), 'workflow', 'revision', 1, '{}', randomblob(32), 'manual',
           'running', 1, 1, 0, 2)`,
      )
      .run(runId, `start-${runId}`);
    insertEvent(database, runId, `accepted-${runId}`, 1, "run.accepted", 0);
  }
  database.close();
};

const insertEvent = (
  database: Database,
  runId: string,
  eventId: string,
  sequence: number,
  kind: string,
  recordedAtMs: number,
) =>
  database
    .query(
      `INSERT INTO kojo_execution_events(
         event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms,
         payload_encoding_version, payload_schema_identity, payload_json,
         payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256
       ) VALUES (?, ?, ?, 1, ?, 1, ?, 1, 'schema', '{}', 1, '{}', zeroblob(32))`,
    )
    .run(eventId, runId, sequence, kind, recordedAtMs);
