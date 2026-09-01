import { Database } from "bun:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

const fixture = (): { readonly database: Database; readonly runs: SqliteRunRepository } => {
  const database = new Database(":memory:", { strict: true });
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  new SqliteProjectRepository(database);
  database.run(
    `INSERT INTO projects (
       project_id, location, project_state, factory_state, refresh_state,
       registered_at, refreshed_at, fault, remedy
     ) VALUES ('project', '/tmp/project', 'available', 'available', 'current', 'now', 'now', NULL, NULL)`,
  );
  database.run(
    "INSERT INTO workflow_revisions VALUES ('revision', 'graph', ?, '/retained', 'now')",
    [JSON.stringify({ entrySource: "workflows/review.ts" })],
  );
  database.run(
    "INSERT INTO project_workflows VALUES ('project', 'review', 'active', 'available', 'workflows/review.ts', NULL, NULL, 'revision', NULL, 'polling', 'now', 'listening', 'now')",
  );
  database.run("INSERT INTO trigger_pollers VALUES ('project', 'review', 'poller', 'now')");
  return { database, runs: new SqliteRunRepository(database) };
};

const admit = (runs: SqliteRunRepository, key: string, at: number) =>
  runs.admit({
    dataIdentity: "data",
    requestId: `admit-${key}`,
    canonicalRequest: JSON.stringify(["admit", key]),
    projectId: "project",
    workflowName: "review",
    idempotencyKey: key,
    payload: { key },
    revisionId: "revision",
    packageGraphId: "graph",
    admittedAt: new Date(at).toISOString(),
  });

describe("SQLite Run cancellation", () => {
  it.effect("moves lifecycle-interrupted execution to recovery without cancellation", () =>
    Effect.gen(function* () {
      const { database, runs } = fixture();
      const admission = yield* admit(runs, "lifecycle-force", 1);
      const authority = yield* runs.claim(
        admission.run.runId,
        "runner-before-force",
        new Date(2).toISOString(),
      );

      yield* runs.recoverInterruptedExecutions(new Date(3).toISOString());

      const recovered = yield* runs.read(admission.run.runId);
      expect(recovered).toMatchObject({
        state: "queued",
        recovery: { state: "interrupted-sibling" },
      });
      expect(recovered?.cancellation).toBeUndefined();
      expect(
        Result.isFailure(
          yield* Effect.result(runs.completeRun(authority, "succeeded", new Date(4).toISOString())),
        ),
      ).toBe(true);
      database.close(false);
    }),
  );

  it.effect("commits the forced Stop boundary before a later Start", () =>
    Effect.gen(function* () {
      const { database, runs } = fixture();
      const before = yield* admit(runs, "before", 1);
      const forced = yield* runs.forceStopWorkflow({
        dataIdentity: "data",
        requestId: "force-stop",
        canonicalRequest: "force-stop-review",
        projectId: "project",
        workflowName: "review",
        acceptedAt: new Date(2).toISOString(),
      });
      const after = yield* admit(runs, "after", 3);
      expect(forced.targetRunIds).toEqual([before.run.runId]);
      expect(yield* runs.read(before.run.runId)).toMatchObject({
        state: "cancelled",
        cancellation: {
          state: "confirmed",
          source: "forced-workflow-stop",
          targetSetId: forced.targetSetId,
        },
      });
      expect(yield* runs.read(after.run.runId)).toMatchObject({ state: "queued" });
      expect((yield* runs.read(after.run.runId))?.cancellation).toBeUndefined();
      expect(database.query("SELECT * FROM workflow_forced_stop_targets").all()).toHaveLength(1);
      expect(database.query("SELECT * FROM trigger_pollers").all()).toHaveLength(0);
      expect(
        database
          .query<{ readonly activity: string }, []>(
            "SELECT activity FROM project_workflows WHERE project_id = 'project' AND workflow_name = 'review'",
          )
          .get()?.activity,
      ).toBe("inactive");
      database.close(false);
    }),
  );

  it.effect("cancels the target, recovers an interrupted sibling, and fences old writes", () =>
    Effect.gen(function* () {
      const { database, runs } = fixture();
      const target = yield* admit(runs, "target", 1);
      const sibling = yield* admit(runs, "sibling", 2);
      const targetAuthority = yield* runs.claim(
        target.run.runId,
        "runner",
        new Date(3).toISOString(),
      );
      const siblingAuthority = {
        runId: sibling.run.runId,
        runnerInstanceId: "runner",
        generation: 1,
        revisionId: "revision",
      };
      database.run("INSERT INTO workflow_claims VALUES (?, 'runner', 1, 'revision', ?)", [
        sibling.run.runId,
        new Date(3).toISOString(),
      ]);
      database.run("INSERT INTO workflow_slots VALUES (?, 'project', 'runner', 1, ?)", [
        sibling.run.runId,
        new Date(3).toISOString(),
      ]);
      database.run("DELETE FROM workflow_queue WHERE run_id = ?", [sibling.run.runId]);
      database.run("UPDATE workflow_runs SET state = 'executing' WHERE run_id = ?", [
        sibling.run.runId,
      ]);
      yield* runs.completePhase(siblingAuthority, {
        phasePath: "recorded-effect",
        attempt: 1,
        kind: "code",
        outcome: "succeeded",
        description: "A completed sibling effect",
        startedAt: new Date(4).toISOString(),
        endedAt: new Date(5).toISOString(),
        encodedResult: { kept: true },
      });
      const requested = yield* runs.requestCancellation(
        target.run.runId,
        "cancel-target",
        new Date(6).toISOString(),
      );
      expect(requested.run.state).toBe("executing");
      expect(requested.run.cancellation?.state).toBe("requested");
      yield* runs.confirmProjectRunnerStopped(
        "project",
        [target.run.runId],
        new Date(7).toISOString(),
        { state: "fault", detail: "sandbox release needs Project repair" },
      );
      expect(yield* runs.read(target.run.runId)).toMatchObject({
        state: "cancelled",
        cancellation: { state: "confirmed" },
        cleanup: { state: "fault", detail: "sandbox release needs Project repair" },
      });
      expect(yield* runs.read(sibling.run.runId)).toMatchObject({
        state: "queued",
        revisionId: "revision",
        recovery: { state: "interrupted-sibling" },
      });
      expect((yield* runs.read(sibling.run.runId))?.cancellation).toBeUndefined();
      expect(yield* runs.phases(sibling.run.runId)).toHaveLength(1);
      expect(
        Result.isFailure(
          yield* Effect.result(
            runs.completeRun(targetAuthority, "succeeded", new Date(8).toISOString()),
          ),
        ),
      ).toBe(true);
      database.close(false);
    }),
  );

  it.effect("lets the first durable terminal decision win the cancellation race", () =>
    Effect.gen(function* () {
      const { database, runs } = fixture();
      const admission = yield* admit(runs, "race", 1);
      const authority = yield* runs.claim(admission.run.runId, "runner", new Date(2).toISOString());
      yield* runs.requestCancellation(
        admission.run.runId,
        "cancel-race",
        new Date(3).toISOString(),
      );
      expect(
        Result.isFailure(
          yield* Effect.result(runs.completeRun(authority, "succeeded", new Date(4).toISOString())),
        ),
      ).toBe(true);
      yield* runs.confirmProjectRunnerStopped(
        "project",
        [admission.run.runId],
        new Date(5).toISOString(),
        { state: "confirmed" },
      );
      expect(yield* runs.read(admission.run.runId)).toMatchObject({
        state: "cancelled",
        cancellation: { state: "confirmed" },
      });

      const completed = yield* admit(runs, "completed-first", 6);
      const completedAuthority = yield* runs.claim(
        completed.run.runId,
        "runner",
        new Date(7).toISOString(),
      );
      yield* runs.completeRun(completedAuthority, "succeeded", new Date(8).toISOString());
      expect(
        Result.isFailure(
          yield* Effect.result(
            runs.requestCancellation(
              completed.run.runId,
              "cancel-completed",
              new Date(9).toISOString(),
            ),
          ),
        ),
      ).toBe(true);
      database.close(false);
    }),
  );

  it.effect("does not requeue durable cancellation intent after Daemon replacement", () =>
    Effect.gen(function* () {
      const { database, runs } = fixture();
      const admission = yield* admit(runs, "replacement", 1);
      const authority = yield* runs.claim(
        admission.run.runId,
        "old-runner",
        new Date(2).toISOString(),
      );
      yield* runs.requestCancellation(
        admission.run.runId,
        "cancel-before-replacement",
        new Date(3).toISOString(),
      );
      yield* runs.recoverInterruptedExecutions(new Date(4).toISOString());
      expect(yield* runs.read(admission.run.runId)).toMatchObject({
        state: "executing",
        cancellation: { state: "requested" },
        cleanup: { state: "pending" },
      });
      expect(
        Result.isFailure(
          yield* Effect.result(runs.completeRun(authority, "succeeded", new Date(5).toISOString())),
        ),
      ).toBe(true);
      database.close(false);
    }),
  );
});
