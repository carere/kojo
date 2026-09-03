import type { Database } from "bun:sqlite";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import {
  decodeTraceMutation,
  type TraceMutation,
} from "@carere/kojo-runner-contracts/contexts/project/contracts/trace";
import { Effect } from "effect";
import type { RunAuthority } from "../../workflow/models/DaemonRun.ts";
import { RunStoreError } from "../../workflow/models/RunStoreError.ts";
import { canonicalJson } from "../../workflow/services/canonicalJson.ts";
import type { TraceProjection } from "../models/DaemonTrace.ts";

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
      mutation_id TEXT UNIQUE NOT NULL,
      run_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      document TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    ) STRICT`);
    database.run(`CREATE TABLE IF NOT EXISTS kojo_run_finishes (
      run_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed', 'suspended')),
      runner_instance_id TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (run_id, generation, runner_instance_id),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    ) STRICT`);
    database.run(`CREATE TABLE IF NOT EXISTS kojo_phase_entries (
      run_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      phase_id TEXT NOT NULL,
      runner_instance_id TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (run_id, generation, runner_instance_id, phase_id),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    ) STRICT`);
  }

  readonly write = (
    authority: RunAuthority,
    mutation: TraceMutation,
  ): Effect.Effect<void, RunStoreError> => {
    const decoded = decodeTraceMutation(mutation);
    if (!decoded.ok) {
      return Effect.fail(
        new RunStoreError({
          code: "STORE_FAILED",
          message: `the Trace mutation is invalid: ${decoded.issues
            .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
            .join("; ")}`,
        }),
      );
    }
    const exact = decoded.value;
    return Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertAuthority(authority);
            if (exact.kind === "run-finished") {
              if (exact.runId !== authority.runId) this.#escaped();
              const inserted = this.#insertAuthorityExact(
                "kojo_run_finishes",
                authority,
                exact.outcome,
                canonicalJson(exact),
              );
              if (inserted) {
                this.#database.run(
                  "UPDATE kojo_runs SET outcome = ?, finished_at = ?, in_flight = NULL WHERE run_id = ?",
                  [exact.outcome, Date.now(), authority.runId],
                );
              }
              return;
            }
            if (exact.kind === "phase-entered") {
              if (exact.runId !== authority.runId) this.#escaped();
              const phase = objectRecord(exact.phase, "the in-flight Phase");
              this.#insertAuthorityExact(
                "kojo_phase_entries",
                authority,
                String(phase.phaseId),
                canonicalJson(exact),
              );
              this.#database.run("UPDATE kojo_runs SET in_flight = ? WHERE run_id = ?", [
                canonicalJson(exact.phase),
                authority.runId,
              ]);
              return;
            }
            const record = objectRecord(exact.record, `the ${exact.kind} Trace record`);
            if (record.runId !== authority.runId) this.#escaped();
            const document = canonicalJson(record);
            if (exact.kind === "run-started") {
              this.#insertExact("kojo_runs", "run_id", authority.runId, document);
            } else if (exact.kind === "phase") {
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
            } else if (exact.kind === "gate") {
              this.#insertExact(
                "kojo_gates",
                "asking",
                String(record.asking),
                document,
                authority.runId,
              );
            } else if (exact.kind === "sandbox") {
              this.#insertExact(
                "kojo_sandboxes",
                "sandbox_id",
                String(record.sandboxId),
                document,
                authority.runId,
              );
            } else {
              this.#database.run(
                "INSERT INTO kojo_occurrences (mutation_id, run_id, phase_id, document) VALUES (?, ?, ?, ?) ON CONFLICT(mutation_id) DO NOTHING",
                [exact.occurrenceId, authority.runId, String(record.phaseId), document],
              );
              const prior = this.#database
                .query<DocumentRow, [string]>(
                  "SELECT document FROM kojo_occurrences WHERE mutation_id = ?",
                )
                .get(exact.occurrenceId);
              if (prior?.document !== document) this.#conflict("kojo_occurrences");
            }
          })
          .immediate(),
      catch: failure,
    });
  };

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
      .map((row) => {
        const kind =
          table === "kojo_phases" ? "phase" : table === "kojo_gates" ? "gate" : "sandbox";
        const decoded = decodeTraceMutation({
          kind,
          record: JSON.parse(row.document) as JsonValue,
        });
        if (!decoded.ok || !("record" in decoded.value)) {
          throw new RunStoreError({
            code: "STORE_FAILED",
            message: `the ${table} row is not an exact Trace record`,
          });
        }
        return decoded.value.record;
      });
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
      this.#conflict(table);
    }
  }

  #insertAuthorityExact(
    table: "kojo_run_finishes" | "kojo_phase_entries",
    authority: RunAuthority,
    identity: string,
    document: string,
  ): boolean {
    let inserted: boolean;
    if (table === "kojo_run_finishes") {
      const priorOutcomes = this.#database
        .query<
          { readonly outcome: "succeeded" | "failed" | "suspended" },
          [string, number, string]
        >(
          "SELECT outcome FROM kojo_run_finishes WHERE run_id = ? AND generation = ? AND runner_instance_id = ?",
        )
        .all(authority.runId, authority.generation, authority.runnerInstanceId);
      if (priorOutcomes.some((row) => row.outcome !== identity)) {
        this.#conflict(table);
      }
      inserted =
        this.#database.run(
          "INSERT INTO kojo_run_finishes (run_id, generation, outcome, runner_instance_id, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, generation, runner_instance_id) DO NOTHING",
          [authority.runId, authority.generation, identity, authority.runnerInstanceId, document],
        ).changes === 1;
    } else {
      inserted =
        this.#database.run(
          "INSERT INTO kojo_phase_entries (run_id, generation, phase_id, runner_instance_id, document) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, generation, runner_instance_id, phase_id) DO NOTHING",
          [authority.runId, authority.generation, identity, authority.runnerInstanceId, document],
        ).changes === 1;
    }
    const prior =
      table === "kojo_run_finishes"
        ? this.#database
            .query<DocumentRow & { readonly runner_instance_id: string }, [string, number, string]>(
              "SELECT runner_instance_id, document FROM kojo_run_finishes WHERE run_id = ? AND generation = ? AND runner_instance_id = ?",
            )
            .get(authority.runId, authority.generation, authority.runnerInstanceId)
        : this.#database
            .query<
              DocumentRow & { readonly runner_instance_id: string },
              [string, number, string, string]
            >(
              "SELECT runner_instance_id, document FROM kojo_phase_entries WHERE run_id = ? AND generation = ? AND runner_instance_id = ? AND phase_id = ?",
            )
            .get(authority.runId, authority.generation, authority.runnerInstanceId, identity);
    if (prior?.runner_instance_id !== authority.runnerInstanceId || prior.document !== document) {
      this.#conflict(table);
    }
    return inserted;
  }

  #conflict(table: string): never {
    throw new RunStoreError({
      code: "REQUEST_CONFLICT",
      message: `the ${table} identity already has different Trace content`,
    });
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
    const slot = this.#database
      .query<{ readonly runner_instance_id: string; readonly generation: number }, [string]>(
        `SELECT s.runner_instance_id, s.generation
           FROM workflow_slots s
           JOIN workflow_runs r ON r.run_id = s.run_id
          WHERE s.run_id = ? AND r.state = 'executing'`,
      )
      .get(authority.runId);
    if (
      claim === null ||
      slot === null ||
      claim.runner_instance_id !== authority.runnerInstanceId ||
      slot.runner_instance_id !== authority.runnerInstanceId ||
      claim.generation !== authority.generation ||
      slot.generation !== authority.generation ||
      claim.revision_id !== authority.revisionId
    )
      this.#escaped();
  }
}
