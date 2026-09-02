import type { Database } from "bun:sqlite";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import type { RunAuthority } from "../../workflow/models/DaemonRun.ts";
import { RunStoreError } from "../../workflow/models/RunStoreError.ts";
import { canonicalJson } from "../../workflow/services/canonicalJson.ts";
import type { TraceMutation, TraceProjection } from "../models/DaemonTrace.ts";

interface DocumentRow {
  readonly document: string;
}

const failure = (cause: unknown): RunStoreError =>
  cause instanceof RunStoreError
    ? cause
    : new RunStoreError({
        code: "STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const objectRecord = (value: JsonValue, name: string): Record<string, JsonValue> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new RunStoreError({ code: "STORE_FAILED", message: `${name} is not a JSON object` });
  }
  return value as Record<string, JsonValue>;
};

/** Sole-owner store for the runtime's completed Trace records. */
export class SqliteTraceRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run("PRAGMA foreign_keys = ON");
    database.run(`CREATE TABLE IF NOT EXISTS kojo_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      document TEXT NOT NULL,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('succeeded', 'failed', 'suspended')),
      finished_at INTEGER,
      in_flight TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    ) STRICT`);
    database.run(`CREATE TABLE IF NOT EXISTS kojo_phases (
      run_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (run_id, phase_id),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    ) STRICT`);
    database.run(`CREATE TABLE IF NOT EXISTS kojo_gates (
      run_id TEXT NOT NULL,
      asking TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (run_id, asking),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    ) STRICT`);
    database.run(`CREATE TABLE IF NOT EXISTS kojo_sandboxes (
      run_id TEXT NOT NULL,
      sandbox_id TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (run_id, sandbox_id),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    ) STRICT`);
    database.run(`CREATE TABLE IF NOT EXISTS kojo_occurrences (
      occurrence_id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      document TEXT NOT NULL UNIQUE,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    ) STRICT`);
  }

  readonly write = (
    authority: RunAuthority,
    mutation: TraceMutation,
  ): Effect.Effect<void, RunStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            if (mutation.kind === "run-finished") {
              if (mutation.runId !== authority.runId) this.#escaped();
              this.#database.run(
                "UPDATE kojo_runs SET outcome = ?, finished_at = ?, in_flight = NULL WHERE run_id = ?",
                [mutation.outcome, mutation.finishedAt, authority.runId],
              );
              return;
            }
            if (mutation.kind === "phase-entered") {
              if (mutation.runId !== authority.runId) this.#escaped();
              this.#database.run("UPDATE kojo_runs SET in_flight = ? WHERE run_id = ?", [
                canonicalJson(mutation.phase),
                authority.runId,
              ]);
              return;
            }
            const record = objectRecord(mutation.record, `the ${mutation.kind} Trace record`);
            if (record.runId !== authority.runId) this.#escaped();
            const document = canonicalJson(record);
            if (mutation.kind === "run-started") {
              this.#insertExact("kojo_runs", "run_id", authority.runId, document);
            } else if (mutation.kind === "phase") {
              this.#insertExact(
                "kojo_phases",
                "phase_id",
                String(record.phaseId),
                document,
                authority.runId,
              );
              this.#database.run("UPDATE kojo_runs SET in_flight = NULL WHERE run_id = ?", [
                authority.runId,
              ]);
            } else if (mutation.kind === "gate") {
              this.#insertExact(
                "kojo_gates",
                "asking",
                String(record.asking),
                document,
                authority.runId,
              );
            } else if (mutation.kind === "sandbox") {
              this.#insertExact(
                "kojo_sandboxes",
                "sandbox_id",
                String(record.sandboxId),
                document,
                authority.runId,
              );
            } else {
              this.#database.run(
                "INSERT INTO kojo_occurrences (run_id, phase_id, document) VALUES (?, ?, ?) ON CONFLICT(document) DO NOTHING",
                [authority.runId, String(record.phaseId), document],
              );
            }
          })
          .immediate(),
      catch: failure,
    });

  readonly projection = (runId: string): Effect.Effect<TraceProjection, RunStoreError> =>
    Effect.try({
      try: () => ({
        phases: this.#documents("kojo_phases", runId),
        gates: this.#documents("kojo_gates", runId),
        sandboxes: this.#documents("kojo_sandboxes", runId),
      }),
      catch: failure,
    });

  #documents(
    table: "kojo_phases" | "kojo_gates" | "kojo_sandboxes",
    runId: string,
  ): ReadonlyArray<Record<string, JsonValue>> {
    return this.#database
      .query<DocumentRow, [string]>(`SELECT document FROM ${table} WHERE run_id = ? ORDER BY rowid`)
      .all(runId)
      .map((row) => objectRecord(JSON.parse(row.document) as JsonValue, `the ${table} row`));
  }

  #insertExact(
    table: "kojo_runs" | "kojo_phases" | "kojo_gates" | "kojo_sandboxes",
    keyColumn: string,
    key: string,
    document: string,
    runId = key,
  ): void {
    this.#database.run(
      `INSERT INTO ${table} (run_id${table === "kojo_runs" ? "" : `, ${keyColumn}`}, document) VALUES (?${table === "kojo_runs" ? "" : ", ?"}, ?) ON CONFLICT DO NOTHING`,
      table === "kojo_runs" ? [runId, document] : [runId, key, document],
    );
    const prior = this.#database
      .query<DocumentRow, [string, string]>(
        `SELECT document FROM ${table} WHERE run_id = ? AND ${keyColumn} = ?`,
      )
      .get(runId, key);
    if (prior?.document !== document) {
      throw new RunStoreError({
        code: "REQUEST_CONFLICT",
        message: `the ${table} identity already has different Trace content`,
      });
    }
  }

  #escaped(): never {
    throw new RunStoreError({
      code: "STALE_AUTHORITY",
      message: "the Trace mutation escaped current Run authority",
    });
  }

  #assertAuthority(authority: RunAuthority): void {
    const claim = this.#database
      .query<
        {
          readonly runner_instance_id: string;
          readonly generation: number;
          readonly revision_id: string;
        },
        [string]
      >("SELECT runner_instance_id, generation, revision_id FROM workflow_claims WHERE run_id = ?")
      .get(authority.runId);
    if (
      claim === null ||
      claim.runner_instance_id !== authority.runnerInstanceId ||
      claim.generation !== authority.generation ||
      claim.revision_id !== authority.revisionId
    )
      this.#escaped();
  }
}
