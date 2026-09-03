import { Database } from "bun:sqlite";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteOperationRepository } from "../../../../src/contexts/daemon/adapters/SqliteOperationRepository.ts";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

const fixture = (
  triggerState: "not-declared" | "not-observed" = "not-observed",
): {
  readonly database: Database;
  readonly projects: SqliteProjectRepository;
  readonly runs: SqliteRunRepository;
} => {
  const database = new Database(":memory:", { strict: true });
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  const operations = new SqliteOperationRepository(database);
  const projects = new SqliteProjectRepository(database, operations);
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
    "INSERT INTO project_workflows VALUES ('project', 'review', 'inactive', 'available', 'workflows/review.ts', NULL, NULL, 'revision', NULL, ?, NULL, NULL, 'now')",
    [triggerState],
  );
  return {
    database,
    projects,
    runs: new SqliteRunRepository(database, { operations }),
  };
};

const startMutation = (requestId: string): MutationEnvelope => ({
  mutationVersion: 1,
  requestId,
  dataIdentity: "data",
  operation: "startWorkflow",
  target: { identityVersion: 1, kind: "workflow", parts: ["project", "review"] },
  arguments: { payload: { change: "reviewed" } },
  preconditions: { workflowMode: "no-trigger", revisionId: "revision" },
});

describe("durable Workflow activity", () => {
  it("atomically admits a no-Trigger Run, activates its Workflow, and records its exact replay", async () => {
    for (const [name, trigger] of [
      [
        "operation",
        "CREATE TRIGGER kill_operation BEFORE INSERT ON daemon_operations BEGIN SELECT RAISE(ABORT, 'kill before operation receipt'); END",
      ],
      [
        "activity",
        "CREATE TRIGGER kill_activity BEFORE UPDATE ON project_workflows BEGIN SELECT RAISE(ABORT, 'kill before Workflow Activity'); END",
      ],
      [
        "activity_receipt",
        "CREATE TRIGGER kill_activity_receipt BEFORE INSERT ON workflow_activity_receipts BEGIN SELECT RAISE(ABORT, 'kill before Activity receipt'); END",
      ],
    ] as const) {
      const { database, projects, runs } = fixture("not-declared");
      const requestId = `atomic-${name}`;
      const mutation = startMutation(requestId);
      const request = {
        dataIdentity: "data",
        requestId,
        canonicalRequest: JSON.stringify(mutation),
        projectId: "project",
        workflowName: "review",
        idempotencyKey: `run-${name}`,
        payload: { change: "reviewed" },
        revisionId: "revision",
        packageGraphId: "graph",
        admittedAt: "2026-09-01T00:00:00.000Z",
        mutation,
        reviewedMode: "no-trigger" as const,
        reviewedRevisionId: "revision",
      };
      database.run(trigger);
      await expect(Effect.runPromise(runs.admitAndActivateWorkflow(request))).rejects.toThrow(
        /kill/,
      );
      expect(await Effect.runPromise(runs.list)).toHaveLength(0);
      expect((await Effect.runPromise(projects.workflow("project", "review")))?.activity).toBe(
        "inactive",
      );
      expect(
        database
          .query<{ readonly count: number }, []>("SELECT COUNT(*) AS count FROM daemon_operations")
          .get()?.count,
      ).toBe(0);
      database.run(`DROP TRIGGER kill_${name}`);
      const first = await Effect.runPromise(runs.admitAndActivateWorkflow(request));
      const replay = await Effect.runPromise(runs.admitAndActivateWorkflow(request));
      expect(replay).toEqual(first);
      expect(await Effect.runPromise(runs.list)).toHaveLength(1);
      expect((await Effect.runPromise(projects.workflow("project", "review")))?.activity).toBe(
        "active",
      );
      expect(
        database
          .query<{ readonly count: number }, []>("SELECT COUNT(*) AS count FROM daemon_operations")
          .get()?.count,
      ).toBe(1);
      await expect(
        Effect.runPromise(
          runs.admitAndActivateWorkflow({
            ...request,
            canonicalRequest: `${request.canonicalRequest}-changed`,
          }),
        ),
      ).rejects.toThrow(/different canonical content/);
      database.close(false);
    }
  });

  it.effect("starts one Trigger poller without an immediate Run and repeats by receipt", () =>
    Effect.gen(function* () {
      const { database, projects, runs } = fixture();
      const first = yield* projects.startActivity({
        dataIdentity: "data",
        requestId: "start-one",
        projectId: "project",
        workflowName: "review",
        changedAt: "2026-09-01T00:00:00.000Z",
      });
      const repeat = yield* projects.startActivity({
        dataIdentity: "data",
        requestId: "start-two",
        projectId: "project",
        workflowName: "review",
        changedAt: "2026-09-01T00:01:00.000Z",
      });
      expect(first.pollerStarted).toBe(true);
      expect(repeat.pollerStarted).toBe(false);
      expect(repeat.pollerId).toBe(first.pollerId);
      expect(yield* projects.triggerPollers).toHaveLength(1);
      expect(yield* runs.list).toHaveLength(0);
      expect((yield* projects.workflow("project", "review"))?.trigger).toMatchObject({
        state: "polling",
        detail: "listening",
      });
      yield* projects.observeTrigger({
        projectId: "project",
        workflowName: "review",
        state: "failed",
        detail: "five transient acknowledgement retries were exhausted",
        observedAt: "2026-09-01T00:02:00.000Z",
      });
      expect(yield* projects.workflow("project", "review")).toMatchObject({
        activity: "active",
        trigger: { state: "failed" },
      });
      database.close(false);
    }),
  );

  it.effect("ordinary Stop closes the poller and keeps an admitted Run eligible", () =>
    Effect.gen(function* () {
      const { database, projects, runs } = fixture();
      yield* projects.startActivity({
        dataIdentity: "data",
        requestId: "start",
        projectId: "project",
        workflowName: "review",
        changedAt: "2026-09-01T00:00:00.000Z",
      });
      const admitted = yield* runs.admit({
        dataIdentity: "data",
        requestId: "run",
        canonicalRequest: "run",
        projectId: "project",
        workflowName: "review",
        idempotencyKey: "run",
        payload: null,
        revisionId: "revision",
        packageGraphId: "graph",
        admittedAt: "2026-09-01T00:00:01.000Z",
      });
      const stopped = yield* projects.stopActivity({
        dataIdentity: "data",
        requestId: "stop",
        projectId: "project",
        workflowName: "review",
        changedAt: "2026-09-01T00:00:02.000Z",
      });
      expect(stopped.activity).toBe("inactive");
      expect(yield* projects.triggerPollers).toHaveLength(0);
      expect((yield* runs.read(admitted.run.runId))?.state).toBe("queued");
      const claimed = yield* runs.claimNext("runner", "2026-09-01T00:00:03.000Z");
      expect(claimed?.run.runId).toBe(admitted.run.runId);
      database.close(false);
    }),
  );

  it.effect("permits a continuation when the Project new-start queue is full", () =>
    Effect.gen(function* () {
      const { database, runs } = fixture();
      const admitted = [];
      for (let index = 0; index < 100; index += 1) {
        admitted.push(
          yield* runs.admit({
            dataIdentity: "data",
            requestId: `run-${index}`,
            canonicalRequest: `run-${index}`,
            projectId: "project",
            workflowName: "review",
            idempotencyKey: `run-${index}`,
            payload: index,
            revisionId: "revision",
            packageGraphId: "graph",
            admittedAt: new Date(index).toISOString(),
          }),
        );
      }
      const first = admitted[0];
      if (first === undefined) throw new Error("the first Run was not admitted");
      const authority = yield* runs.claim(first.run.runId, "runner", new Date(200).toISOString());
      yield* runs.suspend(authority, new Date(201).toISOString());
      yield* runs.admit({
        dataIdentity: "data",
        requestId: "new-at-limit",
        canonicalRequest: "new-at-limit",
        projectId: "project",
        workflowName: "review",
        idempotencyKey: "new-at-limit",
        payload: null,
        revisionId: "revision",
        packageGraphId: "graph",
        admittedAt: new Date(202).toISOString(),
      });
      yield* runs.continueRun(first.run.runId, new Date(203).toISOString());
      const counts = database
        .query<{ readonly kind: string; readonly count: number }, []>(
          "SELECT queue_kind AS kind, COUNT(*) AS count FROM workflow_queue GROUP BY queue_kind ORDER BY kind",
        )
        .all();
      expect(counts).toEqual([
        { kind: "continuation", count: 1 },
        { kind: "new", count: 100 },
      ]);
      const resumed = yield* runs.claimNext("runner-resumed", new Date(204).toISOString());
      expect(resumed?.run.runId).toBe(first.run.runId);
      expect(resumed?.authority.generation).toBe(authority.generation + 1);
      database.close(false);
    }),
  );
});
