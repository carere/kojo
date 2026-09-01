import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach } from "vitest";
import { SqliteConfigurationRepository } from "../../../../src/contexts/daemon/adapters/SqliteConfigurationRepository.ts";
import { SqliteRetentionRepository } from "../../../../src/contexts/daemon/adapters/SqliteRetentionRepository.ts";
import { ConfigurationApi } from "../../../../src/contexts/daemon/services/ConfigurationApi.ts";
import { SqliteDaemonGateRepository } from "../../../../src/contexts/gate/adapters/SqliteDaemonGateRepository.ts";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteTriggerRepository } from "../../../../src/contexts/trigger/adapters/SqliteTriggerRepository.ts";
import { SqliteExternalActionRepository } from "../../../../src/contexts/workflow/adapters/SqliteExternalActionRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const statusValue = (
  status: {
    readonly fields: ReadonlyArray<{ readonly path: string; readonly effective: unknown }>;
  },
  path: string,
) => status.fields.find((field) => field.path === path)?.effective;

const retentionFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "kojo-configuration-retention-"));
  roots.push(root);
  const database = new Database(join(root, "kojo.db"), { strict: true });
  database.run("PRAGMA foreign_keys = ON");
  database.run(`
    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL,
      finished_at TEXT
    ) STRICT
  `);
  database.run(`
    CREATE TABLE workflow_external_actions (
      action_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      state TEXT NOT NULL
    ) STRICT
  `);
  database.run(`
    CREATE TABLE retained_artifacts (
      artifact_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      retained_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL
    ) STRICT
  `);
  database.run(`
    CREATE TABLE kojo_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      outcome TEXT NOT NULL,
      finished_at INTEGER
    ) STRICT
  `);
  for (const table of ["kojo_occurrences", "kojo_phases", "kojo_gates", "kojo_sandboxes"]) {
    database.run(`CREATE TABLE ${table} (run_id TEXT NOT NULL, detail TEXT) STRICT`);
  }
  const finishedAt = "2026-09-01T09:00:00.000Z";
  database.run("INSERT INTO workflow_runs VALUES (?, 'succeeded', ?)", [
    "run-eligible",
    finishedAt,
  ]);
  database.run("INSERT INTO workflow_runs VALUES (?, 'failed', ?)", ["run-protected", finishedAt]);
  database.run("INSERT INTO workflow_external_actions VALUES (?, ?, 'unresolved')", [
    "action-protected",
    "run-protected",
  ]);
  database.run("INSERT INTO kojo_runs VALUES (?, 'succeeded', ?)", [
    "run-eligible",
    Date.parse(finishedAt),
  ]);
  database.run("INSERT INTO kojo_runs VALUES (?, 'failed', ?)", [
    "run-protected",
    Date.parse(finishedAt),
  ]);
  for (const table of ["kojo_occurrences", "kojo_phases", "kojo_gates", "kojo_sandboxes"]) {
    database.run(`INSERT INTO ${table} VALUES ('run-eligible', 'eligible')`);
    database.run(`INSERT INTO ${table} VALUES ('run-protected', 'protected')`);
  }
  const eligiblePath = join(root, "artifacts", "run-eligible", "eligible.txt");
  const protectedPath = join(root, "artifacts", "run-protected", "protected.txt");
  const eligibleContent = "eligible\n";
  const protectedContent = "protected\n";
  mkdirSync(join(eligiblePath, ".."), { recursive: true, mode: 0o700 });
  mkdirSync(join(protectedPath, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(eligiblePath, eligibleContent, { mode: 0o600 });
  writeFileSync(protectedPath, protectedContent, { mode: 0o600 });
  database.run("INSERT INTO retained_artifacts VALUES (?, ?, ?, ?, ?, ?)", [
    "artifact-eligible",
    "run-eligible",
    finishedAt,
    eligiblePath,
    Buffer.byteLength(eligibleContent),
    new Bun.CryptoHasher("sha256").update(eligibleContent).digest("hex"),
  ]);
  database.run("INSERT INTO retained_artifacts VALUES (?, ?, ?, ?, ?, ?)", [
    "artifact-protected",
    "run-protected",
    finishedAt,
    protectedPath,
    Buffer.byteLength(protectedContent),
    new Bun.CryptoHasher("sha256").update(protectedContent).digest("hex"),
  ]);
  const configuration = new SqliteConfigurationRepository(database);
  const retention = new SqliteRetentionRepository(database, root);
  const api = new ConfigurationApi({
    dataIdentity: "data-1",
    now: () => Date.parse("2026-09-01T10:00:00.000Z"),
    configuration,
    retention,
  });
  return { root, database, configuration, retention, api, eligiblePath, protectedPath };
};

const shortRetention = {
  set: { retention: { runHistoryMs: 1, traceMs: 1, artifactMs: 1 } },
};

describe("SQLite configuration retention", () => {
  it.effect("revalidates concurrent state and collects only the disclosed safe evidence", () =>
    Effect.gen(function* () {
      const fixture = retentionFixture();
      const first = yield* fixture.api.check({ scope: "daemon" }, shortRetention);
      expect(first.plan?.impact).toMatchObject({
        runIds: ["run-eligible"],
        traceRunIds: ["run-eligible"],
        artifactIds: ["artifact-eligible"],
        protectedRunIds: ["run-protected"],
      });

      fixture.database.run("INSERT INTO workflow_runs VALUES (?, 'succeeded', ?)", [
        "run-concurrent",
        "2026-09-01T10:00:00.000Z",
      ]);
      const dataFailure = yield* Effect.flip(fixture.api.confirm(first.plan?.planId ?? "missing"));
      expect(dataFailure.code).toBe("CONFIGURATION_PLAN_STALE");
      expect(
        statusValue(yield* fixture.api.status({ scope: "daemon" }), "retention.runHistoryMs"),
      ).toBe("indefinite");
      expect(existsSync(fixture.eligiblePath)).toBe(true);
      fixture.database.run("DELETE FROM workflow_runs WHERE run_id = 'run-concurrent'");

      const second = yield* fixture.api.check({ scope: "daemon" }, shortRetention);
      yield* fixture.api.apply({ scope: "daemon" }, { set: { limits: { newStartQueue: 9 } } });
      const configFailure = yield* Effect.flip(
        fixture.api.confirm(second.plan?.planId ?? "missing"),
      );
      expect(configFailure.code).toBe("CONFIGURATION_PLAN_STALE");
      expect(existsSync(fixture.eligiblePath)).toBe(true);

      const third = yield* fixture.api.check({ scope: "daemon" }, shortRetention);
      const applied = yield* fixture.api.confirm(third.plan?.planId ?? "missing");
      expect(applied.collection).toEqual({
        runs: ["run-eligible"],
        traces: ["run-eligible"],
        artifacts: ["artifact-eligible"],
      });
      expect(existsSync(fixture.eligiblePath)).toBe(false);
      expect(existsSync(fixture.protectedPath)).toBe(true);
      expect(
        fixture.database.query("SELECT * FROM workflow_runs WHERE run_id = 'run-eligible'").get(),
      ).toBeNull();
      expect(
        fixture.database.query("SELECT * FROM workflow_runs WHERE run_id = 'run-protected'").get(),
      ).not.toBeNull();
      expect(
        fixture.database.query("SELECT * FROM kojo_runs WHERE run_id = 'run-protected'").get(),
      ).not.toBeNull();
      expect(
        fixture.database
          .query("SELECT * FROM retained_artifacts WHERE artifact_id = 'artifact-protected'")
          .get(),
      ).not.toBeNull();
      expect(fixture.database.query("SELECT * FROM retention_file_cleanup").all()).toEqual([]);

      const replayed = yield* fixture.api.confirm(third.plan?.planId ?? "missing");
      expect(replayed).toEqual(applied);
      fixture.database.close(false);
    }),
  );

  it.effect("collects Run correctness, Trace, and Artifact evidence separately", () =>
    Effect.gen(function* () {
      const runOnly = retentionFixture();
      const runPlan = yield* runOnly.api.check(
        { scope: "daemon" },
        { set: { retention: { runHistoryMs: 1 } } },
      );
      expect(runPlan.plan?.impact).toMatchObject({
        runIds: ["run-eligible"],
        traceRunIds: [],
        artifactIds: [],
      });
      yield* runOnly.api.confirm(runPlan.plan?.planId ?? "missing");
      expect(
        runOnly.database.query("SELECT * FROM workflow_runs WHERE run_id = 'run-eligible'").get(),
      ).toBeNull();
      expect(
        runOnly.database.query("SELECT * FROM kojo_runs WHERE run_id = 'run-eligible'").get(),
      ).not.toBeNull();
      expect(existsSync(runOnly.eligiblePath)).toBe(true);
      runOnly.database.close(false);

      const traceOnly = retentionFixture();
      const tracePlan = yield* traceOnly.api.check(
        { scope: "daemon" },
        { set: { retention: { traceMs: 1 } } },
      );
      expect(tracePlan.plan?.impact).toMatchObject({
        runIds: [],
        traceRunIds: ["run-eligible"],
        artifactIds: [],
      });
      yield* traceOnly.api.confirm(tracePlan.plan?.planId ?? "missing");
      expect(
        traceOnly.database.query("SELECT * FROM workflow_runs WHERE run_id = 'run-eligible'").get(),
      ).not.toBeNull();
      expect(
        traceOnly.database.query("SELECT * FROM kojo_runs WHERE run_id = 'run-eligible'").get(),
      ).toBeNull();
      expect(existsSync(traceOnly.eligiblePath)).toBe(true);
      traceOnly.database.close(false);

      const artifactOnly = retentionFixture();
      const artifactPlan = yield* artifactOnly.api.check(
        { scope: "daemon" },
        { set: { retention: { artifactMs: 1 } } },
      );
      expect(artifactPlan.plan?.impact).toMatchObject({
        runIds: [],
        traceRunIds: [],
        artifactIds: ["artifact-eligible"],
      });
      yield* artifactOnly.api.confirm(artifactPlan.plan?.planId ?? "missing");
      expect(
        artifactOnly.database
          .query("SELECT * FROM workflow_runs WHERE run_id = 'run-eligible'")
          .get(),
      ).not.toBeNull();
      expect(
        artifactOnly.database.query("SELECT * FROM kojo_runs WHERE run_id = 'run-eligible'").get(),
      ).not.toBeNull();
      expect(existsSync(artifactOnly.eligiblePath)).toBe(false);
      artifactOnly.database.close(false);
    }),
  );

  it.effect("keeps pending Daemon settings pending across automatic construction", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kojo-configuration-activation-"));
      roots.push(root);
      const path = join(root, "kojo.db");
      const firstDatabase = new Database(path, { strict: true });
      const first = new SqliteConfigurationRepository(firstDatabase);
      const pending = yield* first.apply({ scope: "daemon" }, [
        { path: "daemon.readinessMs", value: 1_000, reset: false },
      ]);
      expect(pending.restartRequired).toBe(true);
      expect(statusValue(pending, "daemon.readinessMs")).toBe(60_000);
      firstDatabase.close(false);

      const replacementDatabase = new Database(path, { strict: true });
      const automaticReplacement = new SqliteConfigurationRepository(replacementDatabase);
      const unchanged = yield* automaticReplacement.status({ scope: "daemon" });
      expect(unchanged.restartRequired).toBe(true);
      expect(statusValue(unchanged, "daemon.readinessMs")).toBe(60_000);

      const activated = yield* automaticReplacement.activatePendingDaemon();
      expect(activated.restartRequired).toBe(false);
      expect(statusValue(activated, "daemon.readinessMs")).toBe(1_000);
      yield* automaticReplacement.apply({ scope: "daemon" }, [
        { path: "daemon.readinessMs", value: 0, reset: true },
      ]);
      const reset = yield* automaticReplacement.activatePendingDaemon();
      expect(statusValue(reset, "daemon.readinessMs")).toBe(60_000);
      expect(
        replacementDatabase
          .query(
            "SELECT * FROM daemon_configuration_settings WHERE path = 'daemon.readinessMs' AND activation = 'effective'",
          )
          .get(),
      ).toBeNull();
      replacementDatabase.close(false);
    }),
  );

  it.effect("refuses an Artifact path outside the private retained root", () =>
    Effect.gen(function* () {
      const fixture = retentionFixture();
      const outsideDirectory = join(fixture.root, "outside");
      mkdirSync(outsideDirectory, { mode: 0o700 });
      const outside = join(outsideDirectory, "outside.txt");
      writeFileSync(outside, "must survive\n", { mode: 0o600 });
      const linkedDirectory = join(fixture.root, "artifacts", "linked");
      symlinkSync(outsideDirectory, linkedDirectory);
      fixture.database.run(
        "UPDATE retained_artifacts SET retained_path = ? WHERE artifact_id = 'artifact-eligible'",
        [join(linkedDirectory, "outside.txt")],
      );
      const checked = yield* fixture.api.check({ scope: "daemon" }, shortRetention);
      const failure = yield* Effect.flip(fixture.api.confirm(checked.plan?.planId ?? "missing"));
      expect(failure.code).toBe("CONFIGURATION_PLAN_STALE");
      expect(existsSync(outside)).toBe(true);
      expect(
        fixture.database
          .query("SELECT * FROM retained_artifacts WHERE artifact_id = 'artifact-eligible'")
          .get(),
      ).not.toBeNull();
      expect(
        statusValue(yield* fixture.api.status({ scope: "daemon" }), "retention.artifactMs"),
      ).toBe("indefinite");
      fixture.database.close(false);
    }),
  );

  it.effect("does not remove a file that replaced the selected Artifact after commit", () =>
    Effect.gen(function* () {
      const fixture = retentionFixture();
      const checked = yield* fixture.api.check({ scope: "daemon" }, shortRetention);
      const plan = checked.plan;
      expect(plan).toBeDefined();
      const observedAt = "2026-09-01T10:00:00.000Z";
      const retention = { runHistoryMs: 1, traceMs: 1, artifactMs: 1 } as const;
      const current = yield* fixture.retention.inspect(retention, observedAt);
      yield* fixture.configuration.confirmPlan(
        plan?.planId ?? "missing",
        "data-1",
        observedAt,
        current.stateFingerprint,
        () => fixture.retention.collectNow(plan?.impact ?? current, retention, observedAt),
      );
      rmSync(fixture.eligiblePath);
      writeFileSync(fixture.eligiblePath, "replacement must survive\n", { mode: 0o600 });
      expect(() => fixture.retention.finishFileCleanup()).toThrow(
        "Artifact cleanup content changed",
      );
      expect(existsSync(fixture.eligiblePath)).toBe(true);
      expect(fixture.database.query("SELECT * FROM retention_file_cleanup").all()).toHaveLength(1);
      fixture.database.close(false);
    }),
  );

  it.effect("rolls back collection failure and retries the same exact plan", () =>
    Effect.gen(function* () {
      const fixture = retentionFixture();
      const checked = yield* fixture.api.check({ scope: "daemon" }, shortRetention);
      const planId = checked.plan?.planId ?? "missing";
      writeFileSync(fixture.eligiblePath, "corrupt\n");
      const failure = yield* Effect.flip(fixture.api.confirm(planId));
      expect(failure.code).toBe("CONFIGURATION_PLAN_STALE");
      expect(
        statusValue(yield* fixture.api.status({ scope: "daemon" }), "retention.artifactMs"),
      ).toBe("indefinite");
      expect(
        fixture.database
          .query("SELECT * FROM retained_artifacts WHERE artifact_id = 'artifact-eligible'")
          .get(),
      ).not.toBeNull();
      expect(fixture.database.query("SELECT * FROM retention_file_cleanup").all()).toEqual([]);

      writeFileSync(fixture.eligiblePath, "eligible\n");
      const applied = yield* fixture.api.confirm(planId);
      expect(applied.collection.artifacts).toEqual(["artifact-eligible"]);
      expect(existsSync(fixture.eligiblePath)).toBe(false);
      fixture.database.close(false);
    }),
  );

  it.effect("collects full Run storage while durable request tombstones remain", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kojo-configuration-full-storage-"));
      roots.push(root);
      for (const directory of ["revisions", "objects", "staging", "artifacts"]) {
        mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
      }
      const database = new Database(join(root, "kojo.db"), { strict: true });
      database.run("PRAGMA foreign_keys = ON");
      database.run(
        "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
      );
      new SqliteProjectRepository(database);
      database.run(
        `INSERT INTO projects (
           project_id, location, project_state, factory_state, refresh_state,
           registered_at, refreshed_at, fault, remedy
         ) VALUES ('project-1', '/tmp/project-1', 'available', 'available', 'current', ?, ?, NULL, NULL)`,
        ["2026-09-01T08:00:00.000Z", "2026-09-01T08:00:00.000Z"],
      );
      const retainedRevision = "a".repeat(64);
      const currentRevision = "c".repeat(64);
      database.run("INSERT INTO workflow_revisions VALUES (?, ?, '{}', ?, ?)", [
        retainedRevision,
        "b".repeat(64),
        join(root, "revisions", retainedRevision),
        "2026-09-01T08:00:00.000Z",
      ]);
      database.run("INSERT INTO workflow_revisions VALUES (?, ?, '{}', ?, ?)", [
        currentRevision,
        "d".repeat(64),
        join(root, "revisions", currentRevision),
        "2026-09-01T08:00:00.000Z",
      ]);
      database.run(
        `INSERT INTO project_workflows VALUES (
           'project-1', 'example', 'inactive', 'available', 'workflows/example.ts',
           NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, ?
         )`,
        [currentRevision, "2026-09-01T08:00:00.000Z"],
      );

      const runs = new SqliteRunRepository(database);
      new SqliteExternalActionRepository(database);
      new SqliteDaemonGateRepository(database);
      new SqliteTriggerRepository(database);
      database.run(`
        CREATE TABLE workflow_revision_collection (
          revision_id TEXT PRIMARY KEY NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('grace', 'collecting', 'collected')),
          eligible_at TEXT,
          collected_at TEXT,
          FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id)
        ) STRICT
      `);
      const admitted = yield* runs.admit({
        dataIdentity: "data-1",
        requestId: "admit-request",
        canonicalRequest: "admit-content",
        projectId: "project-1",
        workflowName: "example",
        idempotencyKey: "retained-run",
        payload: null,
        revisionId: retainedRevision,
        packageGraphId: "b".repeat(64),
        admittedAt: "2026-09-01T08:00:00.000Z",
      });
      const runId = admitted.run.runId;
      yield* runs.failQueuedRun(runId, "2026-09-01T09:00:00.000Z");
      database.run(
        "INSERT INTO trigger_deliveries VALUES ('project-1', 'example', 'source', 'event-1', 'acknowledged', ?, NULL, ?)",
        [runId, "2026-09-01T08:00:00.000Z"],
      );
      database.run(
        `INSERT INTO gate_askings (
           identity_key, token, run_id, project_id, workflow_name, gate_path,
           asking_number, escalation_stage, description, actor, choices_json,
           deadline, expiry_branch, internal_deferred_name, created_at, state, applied_at
         ) VALUES ('asking-1', 'token-1', ?, 'project-1', 'example', 'approval', 1, 0,
                   'approve', 'reviewer', '["approve"]', ?, 'fail', 'approval', ?, 'applied', ?)`,
        [runId, "2026-09-01T08:30:00.000Z", "2026-09-01T08:00:00.000Z", "2026-09-01T08:10:00.000Z"],
      );
      database.run(
        "INSERT INTO gate_answer_receipts VALUES ('data-1', 'gate-request', 'gate-content', 'token-1', ?)",
        ["2026-09-01T08:05:00.000Z"],
      );
      database.run(
        `INSERT INTO workflow_external_actions (
           action_id, run_id, revision_id, phase_path, attempt, input_hash,
           recovery_policy, state, intended_at, updated_at, evidence_kind,
           evidence_detail, evidence_observed_at, evidence_result_json
         ) VALUES ('action-1', ?, ?, 'phase', 1, 'input', 'recover-result',
                   'result-confirmed', ?, ?, 'original-result', 'confirmed', ?, 'null')`,
        [
          runId,
          retainedRevision,
          "2026-09-01T08:00:00.000Z",
          "2026-09-01T08:01:00.000Z",
          "2026-09-01T08:01:00.000Z",
        ],
      );
      database.run(
        "INSERT INTO workflow_uncertain_retry_receipts VALUES ('data-1', 'retry-request', 'retry-content', 'action-1', 0, ?)",
        ["2026-09-01T08:00:00.000Z"],
      );
      database.run("INSERT INTO workflow_cancellation_receipts VALUES ('cancel-request', ?, ?)", [
        runId,
        "2026-09-01T08:00:00.000Z",
      ]);
      database.run(
        "INSERT INTO workflow_forced_stop_sets VALUES ('set-1', 'data-1', 'force-request', 'force-content', 'project-1', 'example', ?)",
        ["2026-09-01T08:00:00.000Z"],
      );
      database.run("INSERT INTO workflow_forced_stop_targets VALUES ('set-1', ?)", [runId]);

      const configuration = new SqliteConfigurationRepository(database);
      const retention = new SqliteRetentionRepository(database, root);
      const api = new ConfigurationApi({
        dataIdentity: "data-1",
        now: () => Date.parse("2026-09-01T10:00:00.000Z"),
        configuration,
        retention,
      });
      const checked = yield* api.check(
        { scope: "daemon" },
        { set: { retention: { runHistoryMs: 1 } } },
      );
      yield* api.confirm(checked.plan?.planId ?? "missing");

      expect(database.query("SELECT * FROM workflow_runs WHERE run_id = ?").get(runId)).toBeNull();
      expect(
        database
          .query<{ readonly run_id: string | null }, []>("SELECT run_id FROM trigger_deliveries")
          .get()?.run_id,
      ).toBeNull();
      for (const table of [
        "workflow_admission_receipts",
        "workflow_cancellation_receipts",
        "workflow_forced_stop_targets",
        "gate_answer_receipts",
        "workflow_uncertain_retry_receipts",
      ]) {
        expect(database.query(`SELECT * FROM ${table}`).all()).toHaveLength(1);
      }
      expect(database.query("SELECT * FROM gate_askings").all()).toEqual([]);
      expect(database.query("SELECT * FROM workflow_external_actions").all()).toEqual([]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database
          .query<{ readonly eligible_at: string }, [string]>(
            "SELECT eligible_at FROM workflow_revision_collection WHERE revision_id = ? AND state = 'grace'",
          )
          .get(retainedRevision)?.eligible_at,
      ).toBe("2026-09-02T10:00:00.000Z");

      const replayFailure = yield* Effect.flip(
        runs.admit({
          dataIdentity: "data-1",
          requestId: "admit-request",
          canonicalRequest: "admit-content",
          projectId: "project-1",
          workflowName: "example",
          idempotencyKey: "retained-run",
          payload: null,
          revisionId: retainedRevision,
          packageGraphId: "b".repeat(64),
          admittedAt: "2026-09-01T10:01:00.000Z",
        }),
      );
      expect(replayFailure.code).toBe("RUN_NOT_FOUND");
      expect(database.query("SELECT * FROM workflow_runs").all()).toEqual([]);
      database.close(false);
    }),
  );
});
