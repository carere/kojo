import { Database } from "bun:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteTraceRepository } from "../../../../src/contexts/trace/adapters/SqliteTraceRepository.ts";

const authority = {
  runId: "run-trace",
  revisionId: "revision-trace",
  runnerInstanceId: "runner-trace",
  generation: 1,
};

const fixture = (): { readonly database: Database; readonly trace: SqliteTraceRepository } => {
  const database = new Database(":memory:", { strict: true });
  database.run(
    "CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL) STRICT",
  );
  database.run(`CREATE TABLE workflow_claims (
    run_id TEXT PRIMARY KEY NOT NULL,
    runner_instance_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    revision_id TEXT NOT NULL
  ) STRICT`);
  database.run(`CREATE TABLE workflow_slots (
    run_id TEXT PRIMARY KEY NOT NULL,
    runner_instance_id TEXT NOT NULL,
    generation INTEGER NOT NULL
  ) STRICT`);
  database.run("INSERT INTO workflow_runs VALUES (?, 'executing')", [authority.runId]);
  database.run("INSERT INTO workflow_claims VALUES (?, ?, ?, ?)", [
    authority.runId,
    authority.runnerInstanceId,
    authority.generation,
    authority.revisionId,
  ]);
  database.run("INSERT INTO workflow_slots VALUES (?, ?, ?)", [
    authority.runId,
    authority.runnerInstanceId,
    authority.generation,
  ]);
  return { database, trace: new SqliteTraceRepository(database) };
};

describe("SQLite Trace repository", () => {
  it("persists exact Phase, Gate, and Sandbox records without null optional fields", async () => {
    const { database, trace } = fixture();
    try {
      await Effect.runPromise(
        trace.write(authority, {
          kind: "run-started",
          record: {
            runId: authority.runId,
            workflow: "release",
            idempotencyKey: "release-one",
            startedAt: 1,
            engineVersion: "test",
            engineCommit: "commit",
            configDigest: "config",
            host: "linux",
          },
        }),
      );
      await Effect.runPromise(
        trace.write(authority, {
          kind: "phase",
          record: {
            runId: authority.runId,
            phaseId: "phase-build",
            name: "build",
            description: "Build the release",
            kind: "code",
            outcome: "succeeded",
            attempt: 1,
            startedAt: 2,
            endedAt: 3,
          },
        }),
      );
      await Effect.runPromise(
        trace.write(authority, {
          kind: "gate",
          record: {
            runId: authority.runId,
            gate: "publish",
            asking: "publish/1",
            token: "token",
            description: "Publish the release",
            actor: "release manager",
            choices: ["publish", "reject"],
            requestedAt: 4,
            deadlineAt: 5,
            onExpiry: "reject",
            outcome: "expired",
          },
        }),
      );
      await Effect.runPromise(
        trace.write(authority, {
          kind: "sandbox",
          record: {
            runId: authority.runId,
            sandboxId: "sandbox-one",
            name: "release",
            provider: "no-sandbox",
            kind: "none",
            branch: "main",
            worktreePath: "/tmp/release",
            environment: { KOJO_RUN_ID: authority.runId },
            acquiredAt: 6,
            releasedAt: 7,
            outcome: "released",
          },
        }),
      );

      const projection = await Effect.runPromise(trace.projection(authority.runId));
      expect(projection.phases).toHaveLength(1);
      expect(projection.gates).toHaveLength(1);
      expect(projection.sandboxes).toHaveLength(1);
      expect(projection.phases[0]).not.toHaveProperty("sandboxId");
      expect(projection.gates[0]).not.toHaveProperty("answerer");
      expect(projection.gates[0]).not.toHaveProperty("answeredAt");
      expect(JSON.stringify(projection)).not.toContain(":null");
    } finally {
      database.close(false);
    }
  });

  it("accepts an exact retry and refuses changed content or stale authority", async () => {
    const { database, trace } = fixture();
    const mutation = {
      kind: "run-started" as const,
      record: {
        runId: authority.runId,
        workflow: "release",
        idempotencyKey: "release-one",
        startedAt: 1,
        engineVersion: "test",
        engineCommit: "commit",
        configDigest: "config",
        host: "linux",
      },
    };
    try {
      await Effect.runPromise(trace.write(authority, mutation));
      await Effect.runPromise(trace.write(authority, mutation));
      await expect(
        Effect.runPromise(
          trace.write(authority, {
            ...mutation,
            record: { ...mutation.record, host: "another-host" },
          }),
        ),
      ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
      await expect(
        Effect.runPromise(trace.write({ ...authority, generation: 2 }, mutation)),
      ).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
    } finally {
      database.close(false);
    }
  });

  it("fences mutable Run status by exact Claim generation", async () => {
    const { database, trace } = fixture();
    const started = {
      kind: "run-started" as const,
      record: {
        runId: authority.runId,
        workflow: "release",
        idempotencyKey: "release-one",
        startedAt: 1,
        engineVersion: "test",
        engineCommit: "commit",
        configDigest: "config",
        host: "linux",
      },
    };
    const entered = {
      kind: "phase-entered" as const,
      runId: authority.runId,
      phase: {
        phaseId: `${authority.runId}/build/1`,
        name: "build",
        kind: "code",
        attempt: 1,
        startedAt: 2,
      },
    };
    const finished = {
      kind: "run-finished" as const,
      runId: authority.runId,
      outcome: "suspended" as const,
    };
    try {
      await Effect.runPromise(trace.write(authority, started));
      await Effect.runPromise(trace.write(authority, entered));
      await Effect.runPromise(trace.write(authority, entered));
      await Effect.runPromise(trace.write(authority, finished));
      await Effect.runPromise(trace.write(authority, finished));
      await expect(
        Effect.runPromise(
          trace.write(authority, {
            ...entered,
            phase: { ...entered.phase, startedAt: 4 },
          }),
        ),
      ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
      await expect(
        Effect.runPromise(trace.write(authority, { ...finished, outcome: "failed" })),
      ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });

      database.run("UPDATE workflow_claims SET generation = 2 WHERE run_id = ?", [authority.runId]);
      database.run("UPDATE workflow_slots SET generation = 2 WHERE run_id = ?", [authority.runId]);
      await Effect.runPromise(
        trace.write({ ...authority, generation: 2 }, { ...finished, outcome: "succeeded" }),
      );
    } finally {
      database.close(false);
    }
  });

  it("keeps identical Occurrences when their mutation identities differ", async () => {
    const { database, trace } = fixture();
    const occurrence = {
      kind: "occurrence" as const,
      occurrenceId: "occurrence-one",
      record: {
        runId: authority.runId,
        phaseId: `${authority.runId}/build/1`,
        kind: "exec",
        name: "true",
        startedAt: 1,
        endedAt: 1,
        outcome: "succeeded",
      },
    };
    try {
      await Effect.runPromise(trace.write(authority, occurrence));
      await Effect.runPromise(trace.write(authority, occurrence));
      await Effect.runPromise(
        trace.write(authority, { ...occurrence, occurrenceId: "occurrence-two" }),
      );
      expect(
        database
          .query<{ readonly count: number }, []>("SELECT COUNT(*) AS count FROM kojo_occurrences")
          .get()?.count,
      ).toBe(2);
      await expect(
        Effect.runPromise(
          trace.write(authority, {
            ...occurrence,
            record: { ...occurrence.record, name: "false" },
          }),
        ),
      ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    } finally {
      database.close(false);
    }
  });
});
