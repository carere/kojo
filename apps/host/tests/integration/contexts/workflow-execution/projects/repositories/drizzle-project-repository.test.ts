import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProjectIdentity, RequestKey, type WorkflowScheduleDefinition } from "@kojo/control";
import { Effect, Schema } from "effect";
import {
  completeProjectRepositoryMigration,
  DrizzleProjectRepositoryLive,
  DrizzleWorkflowRunRepositoryLive,
  DrizzleWorkflowScheduleRepositoryLive,
  migrateProjectRepository,
} from "../../../../../../src/contexts/workflow-execution/projects/repositories/drizzle-project-repository";
import { ProjectRepository } from "../../../../../../src/contexts/workflow-execution/projects/repositories/project-repository";
import { WorkflowRunRepository } from "../../../../../../src/contexts/workflow-execution/runs/repositories/workflow-run-repository";
import { WorkflowScheduleRepository } from "../../../../../../src/contexts/workflow-execution/schedules/repositories/workflow-schedule-repository";
import { nextWorkflowScheduleOccurrence } from "../../../../../../src/contexts/workflow-execution/schedules/services/schedule-timing";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Drizzle Project store recovery", () => {
  it.effect("blocks activation while deletion recovery is pending", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        initializedProject("kojo-store-pending-deletion-"),
      );
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath);
        database.exec(
          "INSERT INTO kojo_deletion_intents(deletion_id, request_key, target_kind, target_sha256, target_snapshot_json, phase, created_at_ms, updated_at_ms) VALUES ('deletion', 'request', 'run', zeroblob(32), '{}', 'quiescing', 1, 1)",
        );
        database.close();
      });

      expect(yield* projectStoreReadiness(fixture.project)).toBe("needs-attention");
    }),
  );

  it.effect("blocks activation when a non-final Workflow Run has no accepted Event", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        initializedProject("kojo-store-run-event-invariant-"),
      );
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath);
        database.exec(
          "INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms) VALUES ('run', 'start', zeroblob(32), 'workflow', 'revision', 1, '{\"execution\":\"one\"}', randomblob(32), 'manual', 'running', 0, 1, 1, 1)",
        );
        database.close();
      });

      expect(yield* projectStoreReadiness(fixture.project)).toBe("needs-attention");
    }),
  );

  it.effect("blocks activation when two Workflow Runs map to one engine execution", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => initializedProject("kojo-store-engine-mapping-"));
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath);
        database.exec(
          "INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms) VALUES ('first', 'start-first', zeroblob(32), 'workflow', 'revision', 1, '{\"execution\":\"shared\"}', randomblob(32), 'manual', 'running', 1, 1, 1, 1); INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms) VALUES ('second', 'start-second', zeroblob(32), 'workflow', 'revision', 1, '{\"execution\":\"shared\"}', randomblob(32), 'manual', 'running', 1, 1, 1, 1); INSERT INTO kojo_execution_events(event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms, payload_encoding_version, payload_schema_identity, payload_json, payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256) VALUES ('first-accepted', 'first', 1, 1, 'run.accepted', 1, 1, 1, 'schema', '{}', 1, '{}', zeroblob(32)); INSERT INTO kojo_execution_events(event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms, payload_encoding_version, payload_schema_identity, payload_json, payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256) VALUES ('second-accepted', 'second', 1, 1, 'run.accepted', 1, 1, 1, 'schema', '{}', 1, '{}', zeroblob(32))",
        );
        database.close();
      });

      expect(yield* projectStoreReadiness(fixture.project)).toBe("needs-attention");
    }),
  );

  it.effect(
    "rejects deep Run sequence, tree, occurrence, attempt, outcome, and Artifact invariant violations",
    () =>
      Effect.gen(function* () {
        const mutations: ReadonlyArray<(database: Database) => void> = [
          (database) =>
            database.exec(
              "UPDATE kojo_workflow_runs SET last_event_sequence = 3 WHERE run_id = 'run'",
            ),
          (database) =>
            database.exec(
              "PRAGMA ignore_check_constraints = ON; UPDATE kojo_workflow_runs SET trigger_kind = 'child', parent_run_id = run_id, child_invocation_key = 'cycle' WHERE run_id = 'run'; PRAGMA ignore_check_constraints = OFF",
            ),
          (database) =>
            database.exec(
              "INSERT INTO kojo_workflow_schedule_states(schedule_key, enabled_intent, condition, row_version, created_at_ms, updated_at_ms) VALUES ('schedule', 0, 'unavailable', 1, 1, 1); INSERT INTO kojo_workflow_schedule_occurrences(schedule_key, scheduled_at_ms, applied_revision, resolved_input_encoding_version, resolved_input_schema_identity, resolved_input_json, resolved_input_sensitivity_map_version, resolved_input_sensitivity_map_json, resolved_input_sha256, outcome, delivery_attempt_count, planned_at_ms, processed_at_ms, linked_run_id, row_version) VALUES ('schedule', 1, 'revision', 1, 'schema', '{}', 1, '{}', zeroblob(32), 'started', 0, 1, 1, 'run', 1)",
            ),
          (database) =>
            database.exec(
              "INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms) VALUES ('attempt-run', 'attempt-start', zeroblob(32), 'workflow', 'revision', 1, '{\"execution\":\"attempt\"}', randomblob(32), 'manual', 'running', 1, 1, 1, 1); INSERT INTO kojo_execution_events(event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms, activity_attempt_id, payload_encoding_version, payload_schema_identity, payload_json, payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256) VALUES ('attempt-event', 'attempt-run', 1, 1, 'run.accepted', 1, 1, 'missing-attempt', 1, 'schema', '{}', 1, '{}', zeroblob(32))",
            ),
          (database) =>
            database.exec(
              "UPDATE kojo_workflow_runs SET outcome_event_id = 'accepted' WHERE run_id = 'run'",
            ),
          (database) =>
            database.exec(
              "PRAGMA foreign_keys = OFF; INSERT INTO kojo_execution_event_artifacts(run_id, event_id, artifact_id, role) VALUES ('run', 'missing-event', 'missing-artifact', 'input'); PRAGMA foreign_keys = ON",
            ),
        ];
        for (const mutate of mutations) {
          const fixture = yield* Effect.promise(() => initializedProject("kojo-store-deep-check-"));
          yield* Effect.sync(() => {
            const database = new Database(fixture.databasePath);
            try {
              insertCompletedRun(database);
              mutate(database);
            } finally {
              database.close();
            }
          });
          expect(yield* projectStorePostflight(fixture.project)).toBe(false);
        }
      }),
  );

  it.effect("does not retry a failed activation migration without an explicit retry", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => initializedProject("kojo-store-one-attempt-"));
      const attempts = yield* Effect.gen(function* () {
        const store = yield* ProjectRepository;
        const first = yield* store.migrate(fixture.project);
        const restored = yield* store.completeMigration(fixture.project, false);
        const automaticRetry = yield* store.migrate(fixture.project);
        return { automaticRetry, first, restored };
      }).pipe(Effect.provide(DrizzleProjectRepositoryLive));

      expect(attempts).toEqual({ first: true, restored: false, automaticRetry: false });
    }),
  );

  it.effect("restores the verified backup when semantic postflight fails", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        initializedProject("kojo-store-semantic-postflight-"),
      );
      const outcome = yield* Effect.gen(function* () {
        const store = yield* ProjectRepository;
        const migrated = yield* store.migrate(fixture.project);
        yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath);
          database.exec(
            "INSERT INTO kojo_deletion_intents(deletion_id, request_key, target_kind, target_sha256, target_snapshot_json, phase, created_at_ms, updated_at_ms) VALUES ('deletion', 'request', 'run', zeroblob(32), '{}', 'quiescing', 1, 1)",
          );
          database.close();
        });
        const postflight = yield* store.postflight(fixture.project);
        const restored = yield* store.completeMigration(fixture.project, postflight);
        return { migrated, postflight, restored };
      }).pipe(Effect.provide(DrizzleProjectRepositoryLive));

      expect(outcome).toEqual({ migrated: true, postflight: false, restored: false });
      const restored = new Database(fixture.databasePath, { readonly: true });
      expect(restored.query("SELECT * FROM kojo_deletion_intents").all()).toEqual([]);
      restored.close();
    }),
  );

  it("keeps the verified backup recoverable when completion durability fails", async () => {
    const fixture = await initializedProject("kojo-store-completion-durability-");
    migrateProjectRepository(fixture.project);
    const changed = new Database(fixture.databasePath);
    changed.exec(
      "INSERT INTO kojo_retention_policy(singleton_key, row_version, updated_at_ms) VALUES (1, 1, 1)",
    );
    changed.close();

    expect(() =>
      completeProjectRepositoryMigration(fixture.project, true, {
        syncDirectory: () => {
          throw new Error("directory sync failed");
        },
      }),
    ).toThrow("directory sync failed");
    expect(await Bun.file(`${fixture.databasePath}.migration-backup.completed`).exists()).toBe(
      true,
    );

    expect(completeProjectRepositoryMigration(fixture.project, false)).toBe(false);
    const restored = new Database(fixture.databasePath, { readonly: true });
    expect(restored.query("SELECT * FROM kojo_retention_policy").all()).toEqual([]);
    restored.close();
    expect(await Bun.file(`${fixture.databasePath}.migration-backup`).exists()).toBe(true);
  });

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

    expect(() => migrateProjectRepository(fixture.project)).toThrow("unsafe Project database");
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

    migrateProjectRepository(fixture.project);
    expect(completeProjectRepositoryMigration(fixture.project, true)).toBe(true);

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

  it("has no persistent provider credential representation", async () => {
    const fixture = await initializedProject("kojo-store-no-provider-credentials-");
    const database = new Database(fixture.databasePath, { readonly: true, strict: true });
    try {
      const schema = (
        database
          .query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
          .all() as ReadonlyArray<{ readonly sql: string }>
      )
        .map((row) => row.sql)
        .join("\n")
        .toLowerCase();
      expect(schema).not.toMatch(/credential|api[_-]?key|access[_-]?token|secret/);
    } finally {
      database.close();
    }
  });
});

describe("Drizzle Execution Trace reads", () => {
  it("keeps Event identifiers global and immutable after append", async () => {
    const fixture = await initializedProject("kojo-execution-trace-immutable-");
    const database = new Database(fixture.databasePath);
    try {
      insertCompletedRun(database);
      database.exec(
        "INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms) VALUES ('second', 'second-start', zeroblob(32), 'workflow', 'revision', 1, '{\"execution\":\"second\"}', randomblob(32), 'manual', 'running', 0, 1, 1, 1)",
      );

      expect(() =>
        database
          .query(
            "INSERT INTO kojo_execution_events(event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms, payload_encoding_version, payload_schema_identity, payload_json, payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256) VALUES ('accepted', 'second', 1, 1, 'run.accepted', 1, 1, 1, 'schema', '{}', 1, '{}', zeroblob(32))",
          )
          .run(),
      ).toThrow();
      expect(() =>
        database
          .query("UPDATE kojo_execution_events SET kind = 'run.failed' WHERE event_id = 'accepted'")
          .run(),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it.effect("keeps concurrent Runs independently sequenced and pages indexed evidence", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => initializedProject("kojo-execution-trace-"));
      const repository = yield* WorkflowRunRepository;
      const accepted = (runId: string, key: string) =>
        repository.acceptManualStart({
          project: fixture.project,
          requestKey: requestKey(key),
          requestHash: new Uint8Array(32),
          runId,
          workflowKey: "workflow",
          workflowRevision: "revision",
          encodedInput: { runId },
          inputSensitivityPaths: [],
          startSnapshot: {
            workflow: {
              workflowKey: "workflow",
              workflowRevision: "revision",
              sourceIdentity: "test",
              inputSchemaFingerprint: "test",
            },
            trigger: { kind: "manual", requestKey: requestKey(key) },
            environment: {
              projectIdentity: fixture.project.identity,
              definitionSnapshotId: "test",
              runtimeKind: "local-effect-workflow",
            },
            input: { runId },
            inputSensitivityPaths: [],
          },
          acceptedAtMs: 1,
        });

      yield* Effect.all([accepted("run-one", "start-one"), accepted("run-two", "start-two")], {
        concurrency: "unbounded",
      });
      const operation = {
        activityName: "publish",
        definitionFingerprint: "publish-v1",
        durableOperationKey: "publish",
      };
      expect(yield* repository.prepareActivity(fixture.project, "run-one", operation, 2)).toEqual({
        _tag: "ready",
        executionGeneration: 1,
      });
      const attempt = yield* repository.startActivityAttempt(
        fixture.project,
        "run-one",
        operation,
        { activityIdempotencyKey: "publish:one", effectRetryNumber: 0, executionGeneration: 1 },
        3,
      );
      yield* repository.observeActivityAttempt(
        fixture.project,
        "run-one",
        attempt.attemptId,
        "success",
        4,
      );

      const first = yield* repository.readTrace(fixture.project, "run-one", {
        filters: {
          activityAttemptIds: [],
          childRunIds: [],
          engineOperationIds: [],
          kinds: ["activity.result-observed"],
        },
        limit: 1,
      });
      const continued = yield* repository.readTrace(fixture.project, "run-one", {
        afterSequence: first?.events[0]?.sequence,
        filters: {
          activityAttemptIds: [],
          childRunIds: [],
          engineOperationIds: [],
          kinds: [],
        },
        limit: 10,
      });
      const secondRun = yield* repository.readTrace(fixture.project, "run-two", {
        filters: {
          activityAttemptIds: [],
          childRunIds: [],
          engineOperationIds: [],
          kinds: [],
        },
        limit: 10,
      });

      expect(first).toMatchObject({
        highWaterSequence: 3,
        hasMore: false,
        events: [{ kind: "activity.result-observed", sequence: 3 }],
      });
      expect(continued?.events.map((event) => event.sequence)).toEqual([]);
      expect(secondRun).toMatchObject({
        highWaterSequence: 1,
        events: [{ kind: "run.accepted", sequence: 1 }],
      });
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath);
        database.exec(
          "CREATE TRIGGER reject_run_two_outcome BEFORE UPDATE ON kojo_workflow_runs WHEN NEW.run_id = 'run-two' BEGIN SELECT RAISE(ABORT, 'reject run state update'); END",
        );
        database.close();
      });
      yield* repository
        .recordOutcome(
          fixture.project,
          "run-two",
          { kind: "completed", sensitivityPaths: [], value: "must roll back" },
          5,
        )
        .pipe(Effect.catchCause(() => Effect.void));
      const rolledBack = yield* repository.readTrace(fixture.project, "run-two", {
        filters: {
          activityAttemptIds: [],
          childRunIds: [],
          engineOperationIds: [],
          kinds: [],
        },
        limit: 10,
      });
      expect(yield* repository.show(fixture.project, "run-two")).toMatchObject({
        run: { state: "running", outcome: null },
      });
      expect(rolledBack).toMatchObject({
        highWaterSequence: 1,
        events: [expect.objectContaining({ sequence: 1, kind: "run.accepted" })],
      });
      const firstRun = yield* repository.readTrace(fixture.project, "run-one", {
        filters: {
          activityAttemptIds: [],
          childRunIds: [],
          engineOperationIds: [],
          kinds: [],
        },
        limit: 10,
      });
      const allEvents = [...(firstRun?.events ?? []), ...(secondRun?.events ?? [])];
      expect(firstRun?.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(new Set(allEvents.map((event) => event.eventId)).size).toBe(allEvents.length);

      yield* repository.recordOutcome(
        fixture.project,
        "run-one",
        { kind: "completed", sensitivityPaths: [], value: "done" },
        5,
      );
      const completed = yield* repository.readTrace(fixture.project, "run-one", {
        filters: {
          activityAttemptIds: [],
          childRunIds: [],
          engineOperationIds: [],
          kinds: [],
        },
        limit: 10,
      });
      expect(yield* repository.show(fixture.project, "run-one")).toMatchObject({
        run: { state: "completed", outcome: { kind: "completed", value: "done" } },
      });
      expect(completed).toMatchObject({
        highWaterSequence: 4,
        runState: "completed",
        events: expect.arrayContaining([
          expect.objectContaining({ sequence: 4, kind: "run.completed" }),
        ]),
      });
    }).pipe(Effect.provide(DrizzleWorkflowRunRepositoryLive)),
  );
});

describe("Drizzle Workflow Schedule reconciliation", () => {
  it.effect("collapses long downtime to one started instant and ignores a backward clock", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => initializedProject("kojo-schedule-downtime-"));
      const schedules = yield* WorkflowScheduleRepository;
      const definition = workflowSchedule("schedule-v1", "allow");
      yield* schedules.reconcile(fixture.project, [definition], 0, nextWorkflowScheduleOccurrence);
      yield* schedules.enable({
        project: fixture.project,
        scheduleKey: definition.scheduleKey,
        scheduleRevision: definition.revision,
        requestKey: requestKey("enable-schedule"),
        requestHash: new Uint8Array(32),
        acceptedAtMs: 0,
        nextOccurrence: nextWorkflowScheduleOccurrence,
      });

      const reconciled = yield* schedules.reconcileDueOccurrence({
        project: fixture.project,
        scheduleKey: definition.scheduleKey,
        observedAtMs: 4 * 60_000,
        nextOccurrence: nextWorkflowScheduleOccurrence,
      });
      expect(reconciled).toMatchObject({
        highWaterMarkMs: 3 * 60_000,
        nextOccurrenceMs: 4 * 60_000,
      });
      const missed = yield* schedules.showOccurrence(
        fixture.project,
        definition.scheduleKey,
        60_000,
      );
      expect(missed).toMatchObject({
        appliedRevision: "schedule-v1",
        outcome: "skipped",
        reasonCode: "schedule.missed-range",
        missedRange: {
          count: 3,
          firstScheduledAtMs: 60_000,
          lastScheduledAtMs: 3 * 60_000,
        },
      });

      yield* schedules.planOccurrence({
        project: fixture.project,
        scheduleKey: definition.scheduleKey,
        scheduledAtMs: 4 * 60_000,
        appliedRevision: definition.revision,
        input: { source: "schedule" },
        inputSensitivityPaths: [],
        plannedAtMs: 4 * 60_000,
      });
      yield* schedules.advanceAfterStart({
        project: fixture.project,
        scheduleKey: definition.scheduleKey,
        scheduledAtMs: 4 * 60_000,
        appliedRevision: definition.revision,
        nextOccurrenceMs: 5 * 60_000,
        advancedAtMs: 4 * 60_000,
      });
      const backward = yield* schedules.reconcileDueOccurrence({
        project: fixture.project,
        scheduleKey: definition.scheduleKey,
        observedAtMs: 2 * 60_000,
        nextOccurrence: nextWorkflowScheduleOccurrence,
      });
      expect(backward).toMatchObject({
        highWaterMarkMs: 4 * 60_000,
        nextOccurrenceMs: 5 * 60_000,
      });
    }).pipe(Effect.provide(DrizzleWorkflowScheduleRepositoryLive)),
  );

  it.effect(
    "invalidates changed work, preserves removal history, and repairs only through a new revision",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => initializedProject("kojo-schedule-lifecycle-"));
        const schedules = yield* WorkflowScheduleRepository;
        const first = workflowSchedule("schedule-v1", "skip");
        yield* schedules.reconcile(fixture.project, [first], 0, nextWorkflowScheduleOccurrence);
        yield* schedules.enable({
          project: fixture.project,
          scheduleKey: first.scheduleKey,
          scheduleRevision: first.revision,
          requestKey: requestKey("enable-schedule"),
          requestHash: new Uint8Array(32),
          acceptedAtMs: 0,
          nextOccurrence: nextWorkflowScheduleOccurrence,
        });
        yield* schedules.planOccurrence({
          project: fixture.project,
          scheduleKey: first.scheduleKey,
          scheduledAtMs: 60_000,
          appliedRevision: first.revision,
          input: { source: "first" },
          inputSensitivityPaths: [],
          plannedAtMs: 1,
        });

        const second = workflowSchedule("schedule-v2", "skip");
        const changed = yield* schedules.reconcile(
          fixture.project,
          [second],
          90_000,
          nextWorkflowScheduleOccurrence,
        );
        expect(changed[0]).toMatchObject({
          enabledIntent: true,
          condition: "available",
          appliedRevision: second.revision,
          nextOccurrenceMs: 120_000,
        });
        expect(
          yield* schedules.showOccurrence(fixture.project, second.scheduleKey, 60_000),
        ).toMatchObject({ outcome: "invalidated", reasonCode: "schedule.definition-changed" });
        expect(
          yield* schedules.planOccurrence({
            project: fixture.project,
            scheduleKey: first.scheduleKey,
            scheduledAtMs: 60_000,
            appliedRevision: first.revision,
            input: { source: "stale-wake-up" },
            inputSensitivityPaths: [],
            plannedAtMs: 90_000,
          }),
        ).toBeUndefined();

        const removed = yield* schedules.reconcile(
          fixture.project,
          [],
          100_000,
          nextWorkflowScheduleOccurrence,
        );
        expect(removed[0]).toMatchObject({
          enabledIntent: true,
          condition: "unavailable",
          nextOccurrenceMs: null,
        });
        const returned = yield* schedules.reconcile(
          fixture.project,
          [second],
          200_000,
          nextWorkflowScheduleOccurrence,
        );
        expect(returned[0]?.nextOccurrenceMs).toBe(240_000);

        yield* schedules.failOccurrence({
          project: fixture.project,
          scheduleKey: second.scheduleKey,
          scheduledAtMs: 240_000,
          appliedRevision: second.revision,
          processedAtMs: 240_000,
          reasonCode: "schedule.input-invalid",
        });
        expect(yield* schedules.show(fixture.project, second.scheduleKey)).toMatchObject({
          condition: "needs-attention",
          conditionReasonCode: "schedule.input-invalid",
          highWaterMarkMs: 240_000,
          nextOccurrenceMs: null,
        });
        yield* schedules.reconcile(
          fixture.project,
          [second],
          250_000,
          nextWorkflowScheduleOccurrence,
        );
        expect(yield* schedules.show(fixture.project, second.scheduleKey)).toMatchObject({
          condition: "needs-attention",
          nextOccurrenceMs: null,
        });

        const repaired = workflowSchedule("schedule-v3", "skip");
        yield* schedules.reconcile(
          fixture.project,
          [repaired],
          260_000,
          nextWorkflowScheduleOccurrence,
        );
        expect(yield* schedules.show(fixture.project, repaired.scheduleKey)).toMatchObject({
          condition: "available",
          appliedRevision: repaired.revision,
          nextOccurrenceMs: 300_000,
        });
        expect(
          yield* schedules.showOccurrence(fixture.project, repaired.scheduleKey, 240_000),
        ).toMatchObject({ outcome: "failed", reasonCode: "schedule.input-invalid" });
      }).pipe(Effect.provide(DrizzleWorkflowScheduleRepositoryLive)),
  );

  it.effect("skips only for non-final work from a skip Schedule", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => initializedProject("kojo-schedule-overlap-"));
      const schedules = yield* WorkflowScheduleRepository;
      const skip = workflowSchedule("schedule-v1", "skip");
      yield* schedules.reconcile(fixture.project, [skip], 0, nextWorkflowScheduleOccurrence);
      yield* schedules.enable({
        project: fixture.project,
        scheduleKey: skip.scheduleKey,
        scheduleRevision: skip.revision,
        requestKey: requestKey("enable-schedule"),
        requestHash: new Uint8Array(32),
        acceptedAtMs: 0,
        nextOccurrence: nextWorkflowScheduleOccurrence,
      });
      yield* schedules.planOccurrence({
        project: fixture.project,
        scheduleKey: skip.scheduleKey,
        scheduledAtMs: 60_000,
        appliedRevision: skip.revision,
        input: { source: "skip" },
        inputSensitivityPaths: [],
        plannedAtMs: 1,
      });
      insertActiveScheduledRun(fixture.databasePath, skip.scheduleKey, 1);
      const skipped = yield* schedules.skipOccurrenceIfOverlapping({
        project: fixture.project,
        scheduleKey: skip.scheduleKey,
        scheduledAtMs: 60_000,
        appliedRevision: skip.revision,
        nextOccurrenceMs: 120_000,
        processedAtMs: 60_000,
      });
      expect(skipped?.nextOccurrenceMs).toBe(120_000);
      expect(
        yield* schedules.showOccurrence(fixture.project, skip.scheduleKey, 60_000),
      ).toMatchObject({ outcome: "skipped", reasonCode: "schedule.overlap" });

      removeRun(fixture.databasePath, "active-scheduled-run");
      insertActiveManualRun(fixture.databasePath);
      yield* schedules.planOccurrence({
        project: fixture.project,
        scheduleKey: skip.scheduleKey,
        scheduledAtMs: 120_000,
        appliedRevision: skip.revision,
        input: { source: "manual-does-not-block" },
        inputSensitivityPaths: [],
        plannedAtMs: 60_000,
      });
      expect(
        yield* schedules.skipOccurrenceIfOverlapping({
          project: fixture.project,
          scheduleKey: skip.scheduleKey,
          scheduledAtMs: 120_000,
          appliedRevision: skip.revision,
          nextOccurrenceMs: 180_000,
          processedAtMs: 120_000,
        }),
      ).toBeUndefined();

      const allow = workflowSchedule("schedule-v2", "allow");
      yield* schedules.reconcile(fixture.project, [allow], 90_000, nextWorkflowScheduleOccurrence);
      expect(yield* schedules.show(fixture.project, allow.scheduleKey)).toMatchObject({
        nextOccurrenceMs: 180_000,
      });
      yield* schedules.planOccurrence({
        project: fixture.project,
        scheduleKey: allow.scheduleKey,
        scheduledAtMs: 180_000,
        appliedRevision: allow.revision,
        input: { source: "allow" },
        inputSensitivityPaths: [],
        plannedAtMs: 90_000,
      });
      expect(
        yield* schedules.skipOccurrenceIfOverlapping({
          project: fixture.project,
          scheduleKey: allow.scheduleKey,
          scheduledAtMs: 180_000,
          appliedRevision: allow.revision,
          nextOccurrenceMs: 240_000,
          processedAtMs: 180_000,
        }),
      ).toBeUndefined();
      expect(
        yield* schedules.showOccurrence(fixture.project, allow.scheduleKey, 180_000),
      ).toMatchObject({ outcome: "planned" });
    }).pipe(Effect.provide(DrizzleWorkflowScheduleRepositoryLive)),
  );
});

const workflowSchedule = (
  revision: string,
  overlapPolicy: "allow" | "skip",
): WorkflowScheduleDefinition => ({
  scheduleKey: "minute-report",
  workflowKey: "report",
  revision,
  cron: "* * * * *",
  timeZone: "UTC",
  overlapPolicy,
  inputRuleRevision: "input-v1",
});

const requestKey = (value: string) => Schema.decodeUnknownSync(RequestKey)(value);

const insertActiveScheduledRun = (
  databasePath: string,
  scheduleKey: string,
  scheduledAtMs: number,
) => {
  const database = new Database(databasePath, { strict: true });
  try {
    database
      .query(
        `INSERT INTO kojo_workflow_runs(
          run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
          engine_reference_version, engine_reference_json, engine_reference_sha256,
          trigger_kind, schedule_key, scheduled_at_ms, schedule_revision, state,
          last_event_sequence, row_version, accepted_at_ms, updated_at_ms
        ) VALUES ('active-scheduled-run', 'active-scheduled-start', zeroblob(32), 'report', '1',
          1, '{"execution":"active"}', randomblob(32), 'schedule', ?, ?, 'schedule-v1',
          'running', 0, 1, 1, 1)`,
      )
      .run(scheduleKey, scheduledAtMs);
  } finally {
    database.close();
  }
};

const insertActiveManualRun = (databasePath: string) => {
  const database = new Database(databasePath, { strict: true });
  try {
    database
      .query(
        `INSERT INTO kojo_workflow_runs(
          run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
          engine_reference_version, engine_reference_json, engine_reference_sha256,
          trigger_kind, state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms
        ) VALUES ('active-manual-run', 'active-manual-start', zeroblob(32), 'report', '1',
          1, '{"execution":"manual"}', randomblob(32), 'manual', 'running', 0, 1, 1, 1)`,
      )
      .run();
  } finally {
    database.close();
  }
};

const removeRun = (databasePath: string, runId: string) => {
  const database = new Database(databasePath, { strict: true });
  try {
    database.query("DELETE FROM kojo_workflow_runs WHERE run_id = ?").run(runId);
  } finally {
    database.close();
  }
};

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
  migrateProjectRepository(project);
  expect(completeProjectRepositoryMigration(project, true)).toBe(true);
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

const projectStoreReadiness = (project: {
  readonly identity: ProjectIdentity;
  readonly path: string;
}) =>
  Effect.flatMap(ProjectRepository, (store) => store.readiness(project)).pipe(
    Effect.provide(DrizzleProjectRepositoryLive),
  );

const projectStorePostflight = (project: {
  readonly identity: ProjectIdentity;
  readonly path: string;
}) =>
  Effect.flatMap(ProjectRepository, (store) => store.postflight(project)).pipe(
    Effect.provide(DrizzleProjectRepositoryLive),
  );

const insertCompletedRun = (database: Database) => {
  database.exec(
    "INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, state, outcome_event_id, last_event_sequence, row_version, accepted_at_ms, updated_at_ms, finalized_at_ms) VALUES ('run', 'start', zeroblob(32), 'workflow', 'revision', 1, '{}', zeroblob(32), 'manual', 'completed', 'outcome', 2, 1, 1, 2, 2); INSERT INTO kojo_execution_events(event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms, payload_encoding_version, payload_schema_identity, payload_json, payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256) VALUES ('accepted', 'run', 1, 1, 'run.accepted', 1, 1, 1, 'schema', '{}', 1, '{}', zeroblob(32)); INSERT INTO kojo_execution_events(event_id, run_id, sequence, envelope_version, kind, kind_version, recorded_at_ms, payload_encoding_version, payload_schema_identity, payload_json, payload_sensitivity_map_version, payload_sensitivity_map_json, payload_sha256) VALUES ('outcome', 'run', 2, 1, 'run.completed', 1, 2, 1, 'schema', '{}', 1, '{}', zeroblob(32))",
  );
};
