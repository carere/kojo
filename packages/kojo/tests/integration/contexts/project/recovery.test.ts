import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SqliteProjectRecoveryRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRecoveryRepository.ts";

const open = (): Database => {
  const database = new Database(":memory:", { strict: true });
  database.run("PRAGMA foreign_keys = ON");
  database.run(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL
    ) STRICT
  `);
  database.run("INSERT INTO projects (project_id) VALUES ('project-a')");
  return database;
};

describe("durable Project Runner recovery", () => {
  it("keeps attempt and delay budgets when a new adapter opens the same Daemon database", async () => {
    const database = open();
    const firstOwner = new SqliteProjectRecoveryRepository(database, {
      replacementDelaysMillis: [1_000, 2_000, 4_000, 8_000, 16_000],
    });
    await Effect.runPromise(
      firstOwner.recordFailure({
        projectId: "project-a",
        runnerInstanceId: "runner-old",
        failedAt: "2026-09-01T00:00:00.000Z",
        fault: "the channel closed",
        operationFailed: true,
      }),
    );

    const replacementDaemon = new SqliteProjectRecoveryRepository(database);
    expect(await Effect.runPromise(replacementDaemon.read("project-a"))).toMatchObject({
      cycle: 1,
      attempts: 1,
      state: "recovering",
      safety: "pending",
      nextAttemptAt: "2026-09-01T00:00:01.000Z",
      priorRunnerInstanceId: "runner-old",
    });
    await expect(
      Effect.runPromise(
        replacementDaemon.confirmSafety("project-a", "wrong-runner", "2026-09-01T00:00:01.000Z"),
      ),
    ).rejects.toThrow("does not name");
    const safe = await Effect.runPromise(
      replacementDaemon.confirmSafety("project-a", "runner-old", "2026-09-01T00:00:01.000Z"),
    );
    expect(safe.safety).toBe("safe");
    database.close(false);
  });

  it("keeps uncertain old-process evidence on a Project safety hold", async () => {
    const database = open();
    const repository = new SqliteProjectRecoveryRepository(database);
    await Effect.runPromise(
      repository.recordFailure({
        projectId: "project-a",
        runnerInstanceId: "runner-old",
        failedAt: "2026-09-01T00:00:00.000Z",
        fault: "stale PID evidence",
        operationFailed: true,
      }),
    );
    const held = await Effect.runPromise(
      repository.holdUncertain(
        "project-a",
        "runner-old",
        "the old process group termination is not confirmed",
      ),
    );
    expect(held).toMatchObject({
      state: "held",
      safety: "uncertain",
      priorRunnerInstanceId: "runner-old",
    });
    expect(
      await Effect.runPromise(repository.repair("project-a", "2026-09-01T00:01:00.000Z")),
    ).toMatchObject({
      cycle: 1,
      state: "held",
      safety: "uncertain",
    });
    database.close(false);
  });
});
