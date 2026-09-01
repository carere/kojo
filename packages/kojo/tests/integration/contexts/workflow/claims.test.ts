import { Database } from "bun:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

describe("SQLite Claim fencing", () => {
  it.effect("rejects a stale holder before a Phase result is stored", () =>
    Effect.gen(function* () {
      const database = new Database(":memory:", { strict: true });
      database.run(
        "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
      );
      new SqliteProjectRepository(database);
      const instant = "2026-09-01T10:00:00.000Z";
      database.run(
        "INSERT INTO projects VALUES (?, ?, 'available', 'available', 'current', ?, ?, NULL, NULL)",
        ["project-1", "/tmp/project-1", instant, instant],
      );
      database.run("INSERT INTO workflow_revisions VALUES (?, ?, '{}', '/retained', ?)", [
        "a".repeat(64),
        "b".repeat(64),
        instant,
      ]);
      database.run(
        "INSERT INTO project_workflows VALUES (?, ?, 'inactive', 'available', 'example.ts', NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, ?)",
        ["project-1", "example", "a".repeat(64), instant],
      );
      const repository = new SqliteRunRepository(database);
      const admission = yield* repository.admit({
        dataIdentity: "data-1",
        requestId: "request-1",
        canonicalRequest: "null",
        projectId: "project-1",
        workflowName: "example",
        idempotencyKey: "one",
        payload: null,
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        admittedAt: instant,
      });
      const authority = yield* repository.claim(admission.run.runId, "runner-1", instant);
      const failure = yield* Effect.flip(
        repository.completeRun({ ...authority, generation: 2 }, "succeeded", instant),
      );
      expect(failure.code).toBe("STALE_AUTHORITY");
      expect(database.query("SELECT * FROM workflow_slots").all()).toHaveLength(1);
      database.close(false);
    }),
  );

  it.effect(
    "requeues a stopped owner's executing Run and increases the replacement generation",
    () =>
      Effect.gen(function* () {
        const database = new Database(":memory:", { strict: true });
        database.run(
          "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
        );
        new SqliteProjectRepository(database);
        const instant = "2026-09-01T10:00:00.000Z";
        database.run(
          "INSERT INTO projects VALUES (?, ?, 'available', 'available', 'current', ?, ?, NULL, NULL)",
          ["project-1", "/tmp/project-1", instant, instant],
        );
        database.run("INSERT INTO workflow_revisions VALUES (?, ?, '{}', '/retained', ?)", [
          "a".repeat(64),
          "b".repeat(64),
          instant,
        ]);
        database.run(
          "INSERT INTO project_workflows VALUES (?, ?, 'inactive', 'available', 'example.ts', NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, ?)",
          ["project-1", "example", "a".repeat(64), instant],
        );
        const repository = new SqliteRunRepository(database);
        const admission = yield* repository.admit({
          dataIdentity: "data-1",
          requestId: "request-recovery",
          canonicalRequest: "null",
          projectId: "project-1",
          workflowName: "example",
          idempotencyKey: "recovery",
          payload: null,
          revisionId: "a".repeat(64),
          packageGraphId: "b".repeat(64),
          admittedAt: instant,
        });
        const stopped = yield* repository.claim(admission.run.runId, "runner-stopped", instant);
        yield* repository.recoverInterruptedExecutions("2026-09-01T10:01:00.000Z");
        expect((yield* repository.read(admission.run.runId))?.state).toBe("queued");

        const replacement = yield* repository.claim(
          admission.run.runId,
          "runner-replacement",
          "2026-09-01T10:02:00.000Z",
        );
        expect(replacement.generation).toBe(stopped.generation + 1);
        const stale = yield* Effect.flip(repository.completeRun(stopped, "succeeded", instant));
        expect(stale.code).toBe("STALE_AUTHORITY");
        database.close(false);
      }),
  );
});
