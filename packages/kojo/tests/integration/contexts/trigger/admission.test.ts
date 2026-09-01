import { Database } from "bun:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteTriggerRepository } from "../../../../src/contexts/trigger/adapters/SqliteTriggerRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

const fixture = (): {
  readonly database: Database;
  readonly projects: SqliteProjectRepository;
  readonly triggers: SqliteTriggerRepository;
} => {
  const database = new Database(":memory:", { strict: true });
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  const projects = new SqliteProjectRepository(database);
  database.run(
    "INSERT INTO projects VALUES ('project', '/tmp/project', 'available', 'available', 'current', 'now', 'now', NULL, NULL)",
  );
  database.run(
    "INSERT INTO workflow_revisions VALUES ('revision', 'graph', '{}', '/retained', 'now')",
  );
  database.run(
    "INSERT INTO project_workflows VALUES ('project', 'review', 'active', 'available', 'workflows/review.ts', NULL, NULL, 'revision', NULL, 'polling', NULL, 'listening', 'now')",
  );
  new SqliteRunRepository(database);
  return { database, projects, triggers: new SqliteTriggerRepository(database) };
};

const event = (eventId: string, key: string) => ({
  projectId: "project",
  workflowName: "review",
  source: "tickets",
  eventId,
  idempotencyKey: key,
  payload: { key },
  revisionId: "revision",
  packageGraphId: "graph",
  deliveredAt: "2026-09-01T00:00:00.000Z",
});

const eventFor = (projectId: string, eventId: string, key: string) => ({
  ...event(eventId, key),
  projectId,
});

describe("Trigger admission", () => {
  it.effect("records acknowledgement only with durable admission or duplicate detection", () =>
    Effect.gen(function* () {
      const { database, triggers } = fixture();
      const first = yield* triggers.admit(event("delivery-one", "unit-one"));
      expect(first.acknowledgement).toBe("durable");
      expect(first.duplicate).toBe(false);
      expect(database.query("SELECT * FROM workflow_runs").all()).toHaveLength(1);
      expect(yield* triggers.deliveries).toEqual([
        expect.objectContaining({
          eventId: "delivery-one",
          state: "acknowledged",
          runId: first.run.runId,
        }),
      ]);

      const lostAckRetry = yield* triggers.admit(event("delivery-one", "unit-one"));
      expect(lostAckRetry).toMatchObject({ duplicate: true, run: { runId: first.run.runId } });
      const redelivery = yield* triggers.admit(event("delivery-two", "unit-one"));
      expect(redelivery).toMatchObject({ duplicate: true, run: { runId: first.run.runId } });
      expect(database.query("SELECT * FROM workflow_runs").all()).toHaveLength(1);
      database.close(false);
    }),
  );

  it.effect("records malformed events as rejected and permits later valid events", () =>
    Effect.gen(function* () {
      const { database, triggers } = fixture();
      yield* triggers.reject(
        {
          projectId: "project",
          workflowName: "review",
          source: "tickets",
          eventId: "malformed",
          revisionId: "revision",
          packageGraphId: "graph",
          deliveredAt: "2026-09-01T00:00:00.000Z",
        },
        "payload does not satisfy the authored schema",
      );
      const admitted = yield* triggers.admit(event("valid", "unit-two"));
      expect(admitted.duplicate).toBe(false);
      expect(yield* triggers.deliveries).toEqual([
        expect.objectContaining({ eventId: "malformed", state: "rejected" }),
        expect.objectContaining({ eventId: "valid", state: "acknowledged" }),
      ]);
      database.close(false);
    }),
  );

  it.effect(
    "leaves a new event unacknowledged at Project capacity but still accepts duplicates",
    () =>
      Effect.gen(function* () {
        const { database, triggers } = fixture();
        let firstRunId = "";
        for (let index = 0; index < 100; index += 1) {
          const admission = yield* triggers.admit(event(`delivery-${index}`, `unit-${index}`));
          if (index === 0) firstRunId = admission.run.runId;
        }
        const refusal = yield* Effect.flip(triggers.admit(event("delivery-over", "unit-over")));
        expect(refusal.code).toBe("QUEUE_FULL");
        expect(
          (yield* triggers.deliveries).some((delivery) => delivery.eventId === "delivery-over"),
        ).toBe(false);
        const duplicate = yield* triggers.admit(event("delivery-duplicate", "unit-0"));
        expect(duplicate).toMatchObject({ duplicate: true, run: { runId: firstRunId } });
        database.close(false);
      }),
  );

  it.effect(
    "enforces the 1000 new-start Daemon queue across Projects",
    () =>
      Effect.gen(function* () {
        const { database, triggers } = fixture();
        for (let projectIndex = 0; projectIndex <= 10; projectIndex += 1) {
          const projectId = `project-${projectIndex}`;
          database.run(
            "INSERT INTO projects VALUES (?, ?, 'available', 'available', 'current', 'now', 'now', NULL, NULL)",
            [projectId, `/tmp/${projectId}`],
          );
          database.run(
            "INSERT INTO project_workflows VALUES (?, 'review', 'active', 'available', 'workflows/review.ts', NULL, NULL, 'revision', NULL, 'polling', NULL, 'listening', 'now')",
            [projectId],
          );
        }
        for (let projectIndex = 0; projectIndex < 10; projectIndex += 1) {
          const projectId = `project-${projectIndex}`;
          for (let runIndex = 0; runIndex < 100; runIndex += 1) {
            yield* triggers.admit(
              eventFor(
                projectId,
                `delivery-${projectIndex}-${runIndex}`,
                `unit-${projectIndex}-${runIndex}`,
              ),
            );
          }
        }

        const refusal = yield* Effect.flip(
          triggers.admit(eventFor("project-10", "delivery-global-over", "unit-global-over")),
        );
        expect(refusal.code).toBe("QUEUE_FULL");
        expect(
          (yield* triggers.deliveries).some(
            (delivery) => delivery.eventId === "delivery-global-over",
          ),
        ).toBe(false);
        expect(database.query("SELECT * FROM workflow_queue").all()).toHaveLength(1_000);
        const duplicate = yield* triggers.admit(
          eventFor("project-0", "delivery-global-duplicate", "unit-0-0"),
        );
        expect(duplicate.duplicate).toBe(true);
        database.close(false);
      }),
    30_000,
  );

  it.effect("refuses and leaves a new Trigger event unacknowledged after ordinary Stop", () =>
    Effect.gen(function* () {
      const { database, projects, triggers } = fixture();
      yield* projects.stopActivity({
        dataIdentity: "data",
        requestId: "stop",
        projectId: "project",
        workflowName: "review",
        changedAt: "2026-09-01T00:00:01.000Z",
      });

      const refusal = yield* Effect.flip(triggers.admit(event("after-stop", "unit-after-stop")));
      expect(refusal.code).toBe("RUN_NOT_ELIGIBLE");
      expect(yield* triggers.deliveries).toEqual([]);
      expect(database.query("SELECT * FROM workflow_runs").all()).toEqual([]);
      database.close(false);
    }),
  );
});
