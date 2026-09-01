import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import type {
  DaemonConfiguration,
  RetentionCollectionResult,
  RetentionImpact,
} from "../models/Configuration.ts";
import { ConfigurationError } from "../models/ConfigurationError.ts";
import type { RetentionRepositoryPort } from "../ports/RetentionRepository.ts";

interface RunRetentionRow {
  readonly run_id: string;
  readonly state: string;
  readonly finished_at: string | null;
}

interface ArtifactRetentionRow {
  readonly artifact_id: string;
  readonly run_id: string;
  readonly published_at: string;
  readonly retained_path: string;
  readonly byte_size: number;
  readonly sha256: string;
}

interface FileCleanupRow {
  readonly retained_path: string;
  readonly device: number;
  readonly inode: number;
  readonly byte_size: number;
  readonly sha256: string;
}

const failed = (cause: unknown): ConfigurationError =>
  cause instanceof ConfigurationError
    ? cause
    : new ConfigurationError({
        code: "CONFIGURATION_STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const terminal = new Set(["succeeded", "failed", "cancelled"]);
const revisionCollectionGraceMillis = 24 * 60 * 60_000;

/** Real SQLite/filesystem retention adapter. Each retention class has its own selection and delete. */
export class SqliteRetentionRepository implements RetentionRepositoryPort {
  readonly #database: Database;
  readonly #artifactRoot: string;

  constructor(database: Database, dataRoot: string) {
    this.#database = database;
    this.#artifactRoot = resolve(dataRoot, "artifacts");
    database.run(`
      CREATE TABLE IF NOT EXISTS retention_file_cleanup (
        retained_path TEXT PRIMARY KEY NOT NULL,
        planned_at TEXT NOT NULL,
        device INTEGER NOT NULL,
        inode INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL
      ) STRICT
    `);
  }

  readonly inspect = (
    retention: DaemonConfiguration["retention"],
    observedAt: string,
  ): Effect.Effect<RetentionImpact, ConfigurationError> =>
    Effect.try({ try: () => this.#inspect(retention, observedAt), catch: failed });

  readonly collect = (
    impact: RetentionImpact,
    retention: DaemonConfiguration["retention"],
    observedAt: string,
  ): Effect.Effect<RetentionCollectionResult, ConfigurationError> =>
    Effect.try({
      try: () =>
        this.#database.transaction(() => this.#collect(impact, retention, observedAt)).immediate(),
      catch: failed,
    });

  readonly collectNow = (
    impact: RetentionImpact,
    retention: DaemonConfiguration["retention"],
    observedAt: string,
  ): RetentionCollectionResult => this.#collect(impact, retention, observedAt);

  readonly finishFileCleanup = (): void => {
    const rows = this.#database
      .query<FileCleanupRow, []>(
        `SELECT retained_path, device, inode, byte_size, sha256
           FROM retention_file_cleanup ORDER BY retained_path`,
      )
      .all();
    for (const row of rows) {
      if (existsSync(row.retained_path)) {
        const evidence = this.#privateArtifactFile(row.retained_path);
        if (
          evidence.device !== row.device ||
          evidence.inode !== row.inode ||
          evidence.byteSize !== row.byte_size ||
          evidence.sha256 !== row.sha256
        ) {
          throw new ConfigurationError({
            code: "CONFIGURATION_PLAN_STALE",
            message: "Artifact cleanup content changed after the configuration transaction",
          });
        }
        rmSync(row.retained_path);
      }
      this.#database.run("DELETE FROM retention_file_cleanup WHERE retained_path = ?", [
        row.retained_path,
      ]);
    }
  };

  #table(name: string): boolean {
    return (
      this.#database
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) !== null
    );
  }

  #protected(run: RunRetentionRow): boolean {
    if (!terminal.has(run.state) || run.finished_at === null) return true;
    const runId = run.run_id;
    if (
      this.#table("workflow_run_recovery") &&
      this.#database
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM workflow_run_recovery WHERE run_id = ?",
        )
        .get(runId) !== null
    ) {
      return true;
    }
    if (this.#table("workflow_run_cleanup")) {
      const cleanup = this.#database
        .query<{ readonly state: string }, [string]>(
          "SELECT state FROM workflow_run_cleanup WHERE run_id = ?",
        )
        .get(runId);
      if (cleanup !== null && cleanup.state !== "confirmed" && cleanup.state !== "not-required") {
        return true;
      }
    }
    if (
      this.#table("project_resource_leases") &&
      this.#database
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM project_resource_leases WHERE run_id = ? AND state <> 'released' LIMIT 1",
        )
        .get(runId) !== null
    ) {
      return true;
    }
    if (
      this.#table("workflow_external_actions") &&
      this.#database
        .query<{ readonly found: number }, [string]>(
          `SELECT 1 AS found FROM workflow_external_actions
            WHERE run_id = ? AND state IN ('intended', 'unresolved', 'retry-authorized') LIMIT 1`,
        )
        .get(runId) !== null
    ) {
      return true;
    }
    if (
      this.#table("artifact_transfers") &&
      this.#database
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM artifact_transfers WHERE run_id = ? LIMIT 1",
        )
        .get(runId) !== null
    ) {
      return true;
    }
    if (
      this.#table("workflow_run_holds") &&
      this.#database
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM workflow_run_holds WHERE run_id = ?",
        )
        .get(runId) !== null
    ) {
      return true;
    }
    if (
      this.#table("workflow_wakeups") &&
      this.#database
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM workflow_wakeups WHERE run_id = ? AND state = 'pending' LIMIT 1",
        )
        .get(runId) !== null
    ) {
      return true;
    }
    if (
      this.#table("gate_askings") &&
      this.#database
        .query<{ readonly found: number }, [string]>(
          "SELECT 1 AS found FROM gate_askings WHERE run_id = ? AND state IN ('unanswered', 'recorded') LIMIT 1",
        )
        .get(runId) !== null
    ) {
      return true;
    }
    if (run.state === "cancelled" && this.#table("workflow_cancellations")) {
      const cancellation = this.#database
        .query<{ readonly confirmed_at: string | null }, [string]>(
          "SELECT confirmed_at FROM workflow_cancellations WHERE run_id = ?",
        )
        .get(runId);
      if (cancellation !== null && cancellation.confirmed_at === null) return true;
    }
    return false;
  }

  #runs(): ReadonlyArray<RunRetentionRow> {
    if (!this.#table("workflow_runs")) return [];
    return this.#database
      .query<RunRetentionRow, []>(
        "SELECT run_id, state, finished_at FROM workflow_runs ORDER BY run_id",
      )
      .all();
  }

  #fingerprint(): string {
    const tableNames = [
      "workflow_runs",
      "workflow_run_recovery",
      "workflow_run_cleanup",
      "workflow_run_holds",
      "workflow_external_actions",
      "project_resource_leases",
      "workflow_wakeups",
      "gate_askings",
      "gate_answer_receipts",
      "workflow_uncertain_retry_receipts",
      "workflow_cancellations",
      "workflow_cancellation_receipts",
      "workflow_forced_stop_targets",
      "workflow_forced_stop_sets",
      "workflow_results",
      "workflow_claims",
      "workflow_slots",
      "workflow_reservations",
      "workflow_queue",
      "workflow_admission_receipts",
      "retained_artifacts",
      "artifact_transfers",
      "artifact_transfer_chunks",
      "trigger_deliveries",
      "kojo_runs",
      "kojo_phases",
      "kojo_gates",
      "kojo_sandboxes",
      "kojo_occurrences",
    ];
    const hasher = new Bun.CryptoHasher("sha256");
    for (const table of tableNames) {
      if (!this.#table(table)) continue;
      const rows = this.#database
        .query<Record<string, unknown>, []>(`SELECT * FROM ${table}`)
        .all();
      const ordered = rows
        .map((row) => JSON.stringify(row, Object.keys(row).toSorted()))
        .toSorted();
      hasher.update(`${table}\0${JSON.stringify(ordered)}\n`);
    }
    return hasher.digest("hex");
  }

  #inspect(retention: DaemonConfiguration["retention"], observedAt: string): RetentionImpact {
    const now = Date.parse(observedAt);
    const runs = this.#runs();
    const protectedRunIds = runs.filter((run) => this.#protected(run)).map((run) => run.run_id);
    const runHistoryMs = retention.runHistoryMs;
    const traceMs = retention.traceMs;
    const artifactMs = retention.artifactMs;
    const runIds =
      runHistoryMs === "indefinite"
        ? []
        : runs
            .filter(
              (run) =>
                !this.#protected(run) &&
                run.finished_at !== null &&
                Date.parse(run.finished_at) <= now - runHistoryMs,
            )
            .map((run) => run.run_id);
    const traceRunIds =
      traceMs === "indefinite" || !this.#table("kojo_runs")
        ? []
        : this.#database
            .query<{ readonly run_id: string }, [number]>(
              `SELECT run_id FROM kojo_runs
                WHERE outcome IN ('succeeded', 'failed', 'cancelled')
                  AND finished_at IS NOT NULL AND finished_at <= ? ORDER BY run_id`,
            )
            .all(now - traceMs)
            .map((row) => row.run_id)
            .filter((runId) => !protectedRunIds.includes(runId));
    const artifactIds =
      artifactMs === "indefinite" || !this.#table("retained_artifacts")
        ? []
        : this.#database
            .query<ArtifactRetentionRow, []>(
              `SELECT artifact_id, run_id, published_at, retained_path, byte_size, sha256
                 FROM retained_artifacts ORDER BY artifact_id`,
            )
            .all()
            .filter(
              (artifact) =>
                Date.parse(artifact.published_at) <= now - artifactMs &&
                !protectedRunIds.includes(artifact.run_id),
            )
            .map((artifact) => artifact.artifact_id);
    return {
      runIds,
      traceRunIds,
      artifactIds,
      protectedRunIds: protectedRunIds.toSorted(),
      stateFingerprint: this.#fingerprint(),
    };
  }

  #collect(
    planned: RetentionImpact,
    retention: DaemonConfiguration["retention"],
    observedAt: string,
  ): RetentionCollectionResult {
    const current = this.#inspect(retention, observedAt);
    if (current.stateFingerprint !== planned.stateFingerprint) {
      throw new ConfigurationError({
        code: "CONFIGURATION_PLAN_STALE",
        message: "retained state changed before collection",
      });
    }
    const exact = (
      plannedIds: ReadonlyArray<string>,
      currentIds: ReadonlyArray<string>,
    ): string[] => {
      const currentSet = new Set(currentIds);
      if (plannedIds.some((id) => !currentSet.has(id))) {
        throw new ConfigurationError({
          code: "CONFIGURATION_PLAN_STALE",
          message: "planned retained data is no longer eligible for collection",
        });
      }
      return [...plannedIds];
    };
    const runIds = exact(planned.runIds, current.runIds);
    const traceRunIds = exact(planned.traceRunIds, current.traceRunIds);
    const artifactIds = exact(planned.artifactIds, current.artifactIds);
    for (const artifactId of artifactIds) {
      const artifact = this.#database
        .query<
          { readonly retained_path: string; readonly byte_size: number; readonly sha256: string },
          [string]
        >("SELECT retained_path, byte_size, sha256 FROM retained_artifacts WHERE artifact_id = ?")
        .get(artifactId);
      if (artifact !== null) {
        if (existsSync(artifact.retained_path)) {
          const evidence = this.#privateArtifactFile(artifact.retained_path);
          if (evidence.byteSize !== artifact.byte_size || evidence.sha256 !== artifact.sha256) {
            throw new ConfigurationError({
              code: "CONFIGURATION_PLAN_STALE",
              message: "retained Artifact content does not match its durable metadata",
            });
          }
          this.#database.run(
            `INSERT INTO retention_file_cleanup (
               retained_path, planned_at, device, inode, byte_size, sha256
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(retained_path) DO UPDATE SET
               planned_at = excluded.planned_at,
               device = excluded.device,
               inode = excluded.inode,
               byte_size = excluded.byte_size,
               sha256 = excluded.sha256`,
            [
              artifact.retained_path,
              observedAt,
              evidence.device,
              evidence.inode,
              evidence.byteSize,
              evidence.sha256,
            ],
          );
        }
      }
      this.#database.run("DELETE FROM retained_artifacts WHERE artifact_id = ?", [artifactId]);
    }
    for (const runId of traceRunIds) this.#deleteTrace(runId);
    for (const runId of runIds) this.#deleteRunCorrectness(runId, observedAt);
    return { runs: runIds, traces: traceRunIds, artifacts: artifactIds };
  }

  #privateArtifactFile(path: string): {
    readonly device: number;
    readonly inode: number;
    readonly byteSize: number;
    readonly sha256: string;
  } {
    const selected = resolve(path);
    const inside = relative(this.#artifactRoot, selected);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new ConfigurationError({
        code: "CONFIGURATION_PLAN_STALE",
        message: "Artifact collection path escapes the private retained Artifact root",
      });
    }
    const expectedUid = process.getuid?.() ?? -1;
    const components = inside.split(sep);
    const directories = [this.#artifactRoot];
    let directory = this.#artifactRoot;
    for (const component of components.slice(0, -1)) {
      directory = join(directory, component);
      directories.push(directory);
    }
    for (const retainedDirectory of directories) {
      if (!existsSync(retainedDirectory)) {
        throw new ConfigurationError({
          code: "CONFIGURATION_PLAN_STALE",
          message: "Artifact collection has a missing private directory",
        });
      }
      const directoryStat = lstatSync(retainedDirectory);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        directoryStat.uid !== expectedUid ||
        (directoryStat.mode & 0o077) !== 0
      ) {
        throw new ConfigurationError({
          code: "CONFIGURATION_PLAN_STALE",
          message: "Artifact collection directory is not private, owned, and symlink-free",
        });
      }
    }
    const stat = lstatSync(selected);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== expectedUid ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new ConfigurationError({
        code: "CONFIGURATION_PLAN_STALE",
        message: "Artifact collection path is not a private owned regular file without a symlink",
      });
    }
    return {
      device: stat.dev,
      inode: stat.ino,
      byteSize: stat.size,
      sha256: new Bun.CryptoHasher("sha256").update(readFileSync(selected)).digest("hex"),
    };
  }

  #deleteTrace(runId: string): void {
    for (const table of ["kojo_occurrences", "kojo_phases", "kojo_gates", "kojo_sandboxes"]) {
      if (this.#table(table)) this.#database.run(`DELETE FROM ${table} WHERE run_id = ?`, [runId]);
    }
    if (this.#table("kojo_runs"))
      this.#database.run("DELETE FROM kojo_runs WHERE run_id = ?", [runId]);
  }

  #deleteRunCorrectness(runId: string, observedAt: string): void {
    const run = this.#runs().find((candidate) => candidate.run_id === runId);
    if (run === undefined || this.#protected(run)) {
      throw new ConfigurationError({
        code: "CONFIGURATION_PLAN_STALE",
        message: `Run ${runId} gained protected evidence before collection`,
      });
    }
    const revisionId = this.#column("workflow_runs", "revision_id")
      ? this.#database
          .query<{ readonly revision_id: string }, [string]>(
            "SELECT revision_id FROM workflow_runs WHERE run_id = ?",
          )
          .get(runId)?.revision_id
      : undefined;
    if (this.#table("trigger_deliveries")) {
      this.#database.run("UPDATE trigger_deliveries SET run_id = NULL WHERE run_id = ?", [runId]);
    }
    const tables = [
      "workflow_wakeups",
      "gate_askings",
      "workflow_external_actions",
      "project_resource_leases",
      "workflow_run_cleanup",
      "workflow_run_recovery",
      "workflow_run_holds",
      "workflow_results",
      "workflow_claims",
      "workflow_slots",
      "workflow_reservations",
      "workflow_queue",
      "workflow_cancellations",
    ];
    for (const table of tables) {
      if (this.#table(table)) this.#database.run(`DELETE FROM ${table} WHERE run_id = ?`, [runId]);
    }
    this.#database.run("DELETE FROM workflow_runs WHERE run_id = ?", [runId]);
    if (revisionId !== undefined) this.#startRevisionGrace(revisionId, observedAt);
  }

  #column(table: string, column: string): boolean {
    if (!this.#table(table)) return false;
    return this.#database
      .query<{ readonly name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .some((candidate) => candidate.name === column);
  }

  #startRevisionGrace(revisionId: string, observedAt: string): void {
    if (!this.#table("workflow_revision_collection")) return;
    const retainedRun = this.#database
      .query<{ readonly found: number }, [string]>(
        "SELECT 1 AS found FROM workflow_runs WHERE revision_id = ? LIMIT 1",
      )
      .get(revisionId);
    const currentWorkflow = this.#table("project_workflows")
      ? this.#database
          .query<{ readonly found: number }, [string]>(
            "SELECT 1 AS found FROM project_workflows WHERE current_revision_id = ? AND availability = 'available' LIMIT 1",
          )
          .get(revisionId)
      : null;
    const retainedReference = this.#table("workflow_revision_refs")
      ? this.#database
          .query<{ readonly found: number }, [string]>(
            "SELECT 1 AS found FROM workflow_revision_refs WHERE revision_id = ? LIMIT 1",
          )
          .get(revisionId)
      : null;
    const activeReader = this.#table("workflow_readers")
      ? this.#database
          .query<{ readonly found: number }, [string]>(
            "SELECT 1 AS found FROM workflow_readers WHERE revision_id = ? AND released_at IS NULL LIMIT 1",
          )
          .get(revisionId)
      : null;
    if (
      retainedRun !== null ||
      currentWorkflow !== null ||
      retainedReference !== null ||
      activeReader !== null
    ) {
      return;
    }
    const eligibleAt = new Date(
      Date.parse(observedAt) + revisionCollectionGraceMillis,
    ).toISOString();
    this.#database.run(
      `INSERT OR IGNORE INTO workflow_revision_collection
         (revision_id, state, eligible_at) VALUES (?, 'grace', ?)`,
      [revisionId, eligibleAt],
    );
  }
}
