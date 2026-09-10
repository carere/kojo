import { Database } from "bun:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteTraceRepository } from "../../../../src/contexts/trace/adapters/SqliteTraceRepository.ts";
import { runDocumentOf } from "../../../../src/contexts/workflow/services/RunDocumentProjection.ts";

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

const publicRun = (projection: Parameters<typeof runDocumentOf>[2]) =>
  runDocumentOf(
    {
      runId: authority.runId,
      projectId: "project-trace",
      workflowName: "release",
      idempotencyKey: "release-one",
      payload: null,
      revisionId: authority.revisionId,
      packageGraphId: "package-graph-trace",
      state: "executing",
      admissionSequence: 1,
      admittedAt: "2026-09-01T00:00:00.000Z",
    },
    [],
    projection,
    [],
  );

describe("SQLite Trace repository", () => {
  it("retains parallel invocation history, partial costs, and stale activity", async () => {
    const { database, trace } = fixture();
    const observe = (
      id: string,
      sequence: number,
      activity: Record<string, string | number | boolean | Record<string, string | number>>,
    ) =>
      Effect.runPromise(
        trace.write(authority, {
          kind: "invocation",
          record: {
            runId: authority.runId,
            phaseId: "phase",
            phasePath: "implement",
            attempt: 1,
            invocationId: id,
            sequence,
            activity,
          },
        }),
      );
    const start = {
      kind: "started",
      at: 100,
      agent: "builder",
      provider: "controlled",
      model: "test",
      system: "retained system",
      user: "retained task",
      renderedPrompt: "retained system and task",
      systemDelivery: "native-system",
      redacted: false,
      truncated: false,
    };
    await observe("a", 0, start);
    await observe("b", 0, start);
    await observe("a", 0, start);
    await observe("a", 1, { kind: "tool-started", at: 110, name: "Read", text: "file.ts" });
    await observe("a", 2, {
      kind: "finished",
      at: 120,
      outcome: "succeeded",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        contextTokens: 10,
        reportedCostUsd: 0.1,
        estimatedCostUsd: 0.2,
        estimateBasis: "test rates",
      },
    });
    let run = publicRun(await Effect.runPromise(trace.projection(authority.runId)));
    expect(run.invocations?.map((call) => call.state)).toEqual(["succeeded", "executing"]);
    expect(run.invocations?.[0]?.activities).toHaveLength(1);
    expect(run.invocations?.[0]?.systemDelivery).toBe("native-system");
    expect(run.invocations?.[0]?.usage?.contextTokens).toBe(10);
    expect(run.invocationTotals).toMatchObject({
      count: 2,
      inputTokens: 20,
      reportedCostUsd: 0.1,
      reportedCostPartial: true,
      estimatedCostUsd: 0.2,
      estimatedCostPartial: true,
      usagePartial: true,
    });
    await observe("b", 1, { kind: "finished", at: 130, outcome: "failed" });
    await observe("repair", 0, start);
    await observe("repair", 1, {
      kind: "finished",
      at: 150,
      outcome: "succeeded",
      usage: { inputTokens: 30, reportedCostUsd: 0.3 },
    });
    await observe("interrupted", 0, start);
    database.run("UPDATE workflow_claims SET generation = 2");
    database.run("UPDATE workflow_slots SET generation = 2");
    run = publicRun(await Effect.runPromise(trace.projection(authority.runId)));
    expect(run.invocations?.at(-1)?.state).toBe("interrupted");
    expect(run.invocations?.[1]?.usage).toBeUndefined();
    expect(run.invocationTotals?.reportedCostUsd).toBeCloseTo(0.4);
    expect(run.invocationTotals?.inputTokens).toBe(50);
    expect(run.invocationTotals?.reportedCostPartial).toBe(true);
    expect(run.invocations?.[0]?.system).toBe("retained system");
    database.close();
  });

  it("persists exact Phase, Gate, and Sandbox records without null optional fields", async () => {
    const { database, trace } = fixture();
    try {
      expect(
        publicRun(await Effect.runPromise(trace.projection(authority.runId))),
      ).not.toHaveProperty("provenance");
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
      expect(publicRun(projection).provenance).toEqual({
        engineVersion: "test",
        engineCommit: "commit",
        configDigest: "config",
        host: "linux",
      });
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

  it.live("retains parallel Phases and clears only the completed attempt", () =>
    Effect.gen(function* () {
      const { database, trace } = fixture();
      try {
        for (const name of ["implement", "review"]) {
          yield* trace.write(authority, {
            kind: "phase-entered",
            runId: authority.runId,
            phase: {
              phaseId: `${authority.runId}/${name}/1`,
              name,
              kind: "agent",
              attempt: 1,
              startedAt: 2,
            },
          });
        }
        expect(publicRun(yield* trace.projection(authority.runId))).toHaveProperty("activePhases", [
          {
            phasePath: "implement",
            kind: "agent",
            attempt: 1,
            startedAt: "1970-01-01T00:00:00.002Z",
          },
          { phasePath: "review", kind: "agent", attempt: 1, startedAt: "1970-01-01T00:00:00.002Z" },
        ]);
        yield* trace.write(authority, {
          kind: "phase",
          record: {
            runId: authority.runId,
            phaseId: `${authority.runId}/implement/1`,
            name: "implement",
            description: "Implement the issue",
            kind: "agent",
            attempt: 1,
            startedAt: 2,
            endedAt: 3,
            outcome: "succeeded",
          },
        });
        // An exact transport retry cannot restore a completed observation.
        yield* trace.write(authority, {
          kind: "phase-entered",
          runId: authority.runId,
          phase: {
            phaseId: `${authority.runId}/implement/1`,
            name: "implement",
            kind: "agent",
            attempt: 1,
            startedAt: 2,
          },
        });
        expect(publicRun(yield* trace.projection(authority.runId))).toHaveProperty("activePhases", [
          { phasePath: "review", kind: "agent", attempt: 1, startedAt: "1970-01-01T00:00:00.002Z" },
        ]);
      } finally {
        database.close(false);
      }
    }),
  );

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
      expect(
        publicRun(await Effect.runPromise(trace.projection(authority.runId))).activePhases,
      ).toHaveLength(1);
      await Effect.runPromise(trace.write(authority, finished));
      await Effect.runPromise(trace.write(authority, finished));
      expect(
        publicRun(await Effect.runPromise(trace.projection(authority.runId))).activePhases,
      ).toEqual([]);
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
      expect(
        publicRun(await Effect.runPromise(trace.projection(authority.runId))).activePhases,
      ).toEqual([]);
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
