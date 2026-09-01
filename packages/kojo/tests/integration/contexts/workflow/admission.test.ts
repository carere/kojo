import { Database } from "bun:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

const databaseWithRevision = (): Database => {
  const database = new Database(":memory:", { strict: true });
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  new SqliteProjectRepository(database);
  database.run(
    "INSERT INTO projects VALUES (?, ?, 'available', 'available', 'current', ?, ?, NULL, NULL)",
    ["project-1", "/tmp/project-1", "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z"],
  );
  database.run("INSERT INTO workflow_revisions VALUES (?, ?, '{}', '/retained', ?)", [
    "a".repeat(64),
    "b".repeat(64),
    "2026-09-01T10:00:00.000Z",
  ]);
  database.run(
    "INSERT INTO project_workflows VALUES (?, ?, 'inactive', 'available', 'workflows/example.ts', NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, ?)",
    ["project-1", "example", "a".repeat(64), "2026-09-01T10:00:00.000Z"],
  );
  return database;
};

describe("SQLite Run admission", () => {
  it.effect("commits the pinned Run, queue entry, and receipt in one durable transaction", () =>
    Effect.gen(function* () {
      const database = databaseWithRevision();
      const repository = new SqliteRunRepository(database);
      const admitted = yield* repository.admit({
        dataIdentity: "data-1",
        requestId: "request-1",
        canonicalRequest: "[1]",
        projectId: "project-1",
        workflowName: "example",
        idempotencyKey: "one",
        payload: [1],
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        admittedAt: "2026-09-01T10:00:00.000Z",
      });
      expect(admitted.run.payload).toEqual([1]);
      expect(database.query("SELECT * FROM workflow_queue").all()).toHaveLength(1);
      expect(database.query("SELECT * FROM workflow_admission_receipts").all()).toHaveLength(1);
      database.close(false);
    }),
  );
});
