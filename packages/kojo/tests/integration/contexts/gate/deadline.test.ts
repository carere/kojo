import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Option } from "effect";
import { SqliteDaemonGateRepository } from "../../../../src/contexts/gate/adapters/SqliteDaemonGateRepository.ts";

const authority = {
  runId: "run-deadline",
  runnerInstanceId: "runner-1",
  generation: 1,
  revisionId: "a".repeat(64),
};

const setup = (path: string): Database => {
  const database = new Database(path, { create: true, strict: true });
  database.run("PRAGMA foreign_keys = ON");
  database.run(`CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    state TEXT NOT NULL,
    admission_sequence INTEGER NOT NULL
  ) STRICT`);
  database.run(`CREATE TABLE IF NOT EXISTS workflow_queue (
    run_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    admission_sequence INTEGER NOT NULL,
    queued_at TEXT NOT NULL
  ) STRICT`);
  database.run(`CREATE TABLE IF NOT EXISTS workflow_claims (
    run_id TEXT PRIMARY KEY NOT NULL,
    runner_instance_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    revision_id TEXT NOT NULL
  ) STRICT`);
  database.run(`CREATE TABLE IF NOT EXISTS workflow_slots (
    run_id TEXT PRIMARY KEY NOT NULL,
    runner_instance_id TEXT NOT NULL,
    generation INTEGER NOT NULL
  ) STRICT`);
  database.run(
    "INSERT OR IGNORE INTO workflow_runs VALUES (?, 'project-1', 'release', 'executing', 1)",
    [authority.runId],
  );
  database.run("INSERT OR REPLACE INTO workflow_claims VALUES (?, ?, ?, ?)", [
    authority.runId,
    authority.runnerInstanceId,
    authority.generation,
    authority.revisionId,
  ]);
  database.run("INSERT OR REPLACE INTO workflow_slots VALUES (?, ?, ?)", [
    authority.runId,
    authority.runnerInstanceId,
    authority.generation,
  ]);
  return database;
};

const asking = {
  identity: {
    identityVersion: 1 as const,
    runId: authority.runId,
    gatePath: "ship",
    askingNumber: 1,
    escalationStage: 0,
  },
  token: "restart-safe-opaque-token",
  projectId: "project-1",
  workflowName: "release",
  description: "Ship this revision?",
  actor: "release-engineer",
  choices: ["approve", "reject"],
  deadline: "2026-09-01T12:00:00.000Z",
  expiryBranch: "fail" as const,
  internalDeferredName: "gate/ship/1",
  createdAt: "2026-09-01T11:00:00.000Z",
};

const failureOf = async <A>(effect: Effect.Effect<A, unknown>): Promise<unknown> => {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag === "Success") throw new Error("the transition unexpectedly succeeded");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

describe("SQLite Gate Deadline", () => {
  it("keeps the absolute Deadline through restart and refuses an answer at it", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-gate-deadline-"));
    const path = join(root, "kojo.db");
    try {
      let database = setup(path);
      let repository = new SqliteDaemonGateRepository(database);
      await Effect.runPromise(repository.createAskingAndSuspend(authority, asking));
      database.close(false);

      database = setup(path);
      repository = new SqliteDaemonGateRepository(database);
      const refusal = (await failureOf(
        repository.recordVerdictAndSchedule({
          dataIdentity: "data-1",
          requestId: "at-deadline",
          canonicalRequest: "at-deadline-content",
          token: asking.token,
          choice: "approve",
          reason: "too late",
          answerer: "operator",
          now: asking.deadline,
        }),
      )) as { readonly code: string };
      expect(refusal.code).toBe("DEADLINE_PASSED");
      expect(await Effect.runPromise(repository.byToken(asking.token))).toMatchObject({
        deadline: asking.deadline,
        state: "expired",
        expiredAt: asking.deadline,
      });
      expect(await Effect.runPromise(repository.deferredApplications(authority.runId))).toEqual([
        expect.objectContaining({ kind: "expiry" }),
      ]);
      database.close(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
