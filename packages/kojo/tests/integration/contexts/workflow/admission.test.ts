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
    `INSERT INTO projects (
       project_id, location, project_state, factory_state, refresh_state,
       registered_at, refreshed_at, fault, remedy
     ) VALUES (?, ?, 'available', 'available', 'current', ?, ?, NULL, NULL)`,
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
      yield* repository.failQueuedRun(admitted.run.runId, "2026-09-01T10:00:01.000Z");
      expect(yield* repository.read(admitted.run.runId)).toMatchObject({
        state: "failed",
        finishedAt: "2026-09-01T10:00:01.000Z",
      });
      expect(database.query("SELECT * FROM workflow_queue").all()).toHaveLength(0);
      database.close(false);
    }),
  );

  it.effect("holds later admission and dispatch after a limit is lowered", () =>
    Effect.gen(function* () {
      const database = databaseWithRevision();
      let daemonLimits = { executingRuns: 2, newStartQueue: 3 };
      let projectLimits = { executingRuns: 2, newStartQueue: 3 };
      const repository = new SqliteRunRepository(database, {
        limits: {
          daemon: () => daemonLimits,
          project: () => projectLimits,
        },
      });
      const request = (key: string) => ({
        dataIdentity: "data-1",
        requestId: `request-${key}`,
        canonicalRequest: JSON.stringify(key),
        projectId: "project-1",
        workflowName: "example",
        idempotencyKey: key,
        payload: key,
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        admittedAt: "2026-09-01T10:00:00.000Z",
      });
      const first = yield* repository.admit(request("first"));
      const second = yield* repository.admit(request("second"));
      const third = yield* repository.admit(request("third"));
      yield* repository.claim(first.run.runId, "runner-1", "2026-09-01T10:00:01.000Z");
      const secondReservation = yield* repository.reserveNext(
        "reservation-second",
        "2026-09-01T10:00:01.000Z",
      );
      expect(secondReservation?.run.runId).toBe(second.run.runId);
      yield* repository.claimReserved("reservation-second", "runner-2", "2026-09-01T10:00:01.000Z");
      daemonLimits = { ...daemonLimits, executingRuns: 3 };
      projectLimits = { ...projectLimits, executingRuns: 3 };
      const thirdReservation = yield* repository.reserveNext(
        "reservation-third",
        "2026-09-01T10:00:01.500Z",
      );
      expect(thirdReservation?.run.runId).toBe(third.run.runId);
      daemonLimits = { ...daemonLimits, executingRuns: 1 };
      projectLimits = { ...projectLimits, executingRuns: 1 };
      const heldDispatch = yield* Effect.flip(
        repository.claimReserved("reservation-third", "runner-3", "2026-09-01T10:00:02.000Z"),
      );
      expect(heldDispatch.code).toBe("RUN_NOT_ELIGIBLE");
      yield* repository.releaseReservation("reservation-third");
      expect(database.query("SELECT * FROM workflow_slots").all()).toHaveLength(2);
      expect((yield* repository.read(first.run.runId))?.state).toBe("executing");
      expect((yield* repository.read(second.run.runId))?.state).toBe("executing");

      const duplicate = yield* repository.admit({
        ...request("third"),
        requestId: "request-third-duplicate",
      });
      expect(duplicate.duplicate).toBe(true);
      daemonLimits = { ...daemonLimits, newStartQueue: 1 };
      projectLimits = { ...projectLimits, newStartQueue: 1 };
      const queueFailure = yield* Effect.flip(repository.admit(request("fourth")));
      expect(queueFailure.code).toBe("QUEUE_FULL");

      database.run("UPDATE workflow_runs SET state = 'suspended' WHERE run_id = ?", [
        first.run.runId,
      ]);
      database.run("DELETE FROM workflow_slots WHERE run_id = ?", [first.run.runId]);
      yield* repository.continueRun(first.run.runId, "2026-09-01T10:00:03.000Z");
      expect(
        database
          .query<{ readonly queue_kind: string }, [string]>(
            "SELECT queue_kind FROM workflow_queue WHERE run_id = ?",
          )
          .get(first.run.runId)?.queue_kind,
      ).toBe("continuation");
      database.close(false);
    }),
  );
});
