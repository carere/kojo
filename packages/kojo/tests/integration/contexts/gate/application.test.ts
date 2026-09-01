import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteDaemonGateRepository } from "../../../../src/contexts/gate/adapters/SqliteDaemonGateRepository.ts";

const authority = {
  runId: "run-application",
  runnerInstanceId: "runner-1",
  generation: 1,
  revisionId: "b".repeat(64),
};

const setup = (path: string): Database => {
  const database = new Database(path, { create: true, strict: true });
  database.run("PRAGMA foreign_keys = ON");
  database.run(
    "CREATE TABLE IF NOT EXISTS workflow_runs (run_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, workflow_name TEXT NOT NULL, state TEXT NOT NULL, admission_sequence INTEGER NOT NULL) STRICT",
  );
  database.run(
    "CREATE TABLE IF NOT EXISTS workflow_queue (run_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, admission_sequence INTEGER NOT NULL, queued_at TEXT NOT NULL) STRICT",
  );
  database.run(
    "CREATE TABLE IF NOT EXISTS workflow_claims (run_id TEXT PRIMARY KEY NOT NULL, runner_instance_id TEXT NOT NULL, generation INTEGER NOT NULL, revision_id TEXT NOT NULL) STRICT",
  );
  database.run(
    "CREATE TABLE IF NOT EXISTS workflow_slots (run_id TEXT PRIMARY KEY NOT NULL, runner_instance_id TEXT NOT NULL, generation INTEGER NOT NULL) STRICT",
  );
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

describe("SQLite Gate application", () => {
  it("keeps an on-time Verdict Recorded until a later fenced Runner marks it Applied", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-gate-application-"));
    const path = join(root, "kojo.db");
    try {
      const database = setup(path);
      const repository = new SqliteDaemonGateRepository(database);
      await Effect.runPromise(
        repository.createAskingAndSuspend(authority, {
          identity: {
            identityVersion: 1,
            runId: authority.runId,
            gatePath: "ship",
            askingNumber: 1,
            escalationStage: 0,
          },
          token: "atomic-verdict-token",
          projectId: "project-1",
          workflowName: "release",
          description: "Ship?",
          actor: "operator",
          choices: ["approve", "reject"],
          deadline: "2026-09-02T00:00:00.000Z",
          expiryBranch: "reject",
          internalDeferredName: "gate/ship/1",
          createdAt: "2026-09-01T20:00:00.000Z",
        }),
      );
      const receipt = await Effect.runPromise(
        repository.recordVerdictAndSchedule({
          dataIdentity: "data-1",
          requestId: "answer-1",
          canonicalRequest: "answer-1-content",
          token: "atomic-verdict-token",
          choice: "approve",
          reason: "green evidence",
          answerer: "operator",
          now: "2026-09-01T20:01:00.000Z",
        }),
      );
      expect(receipt.asking.state).toBe("recorded");
      expect(database.query("SELECT count(*) AS count FROM gate_answer_receipts").get()).toEqual({
        count: 1,
      });
      expect(
        database.query("SELECT state FROM workflow_runs WHERE run_id = ?").get(authority.runId),
      ).toEqual({ state: "queued" });
      const application = (
        await Effect.runPromise(repository.deferredApplications(authority.runId))
      )[0];
      expect(application).toMatchObject({ kind: "verdict", deferredName: "gate/ship/1" });

      database.run("UPDATE workflow_runs SET state = 'executing' WHERE run_id = ?", [
        authority.runId,
      ]);
      database.run("INSERT OR REPLACE INTO workflow_claims VALUES (?, ?, ?, ?)", [
        authority.runId,
        authority.runnerInstanceId,
        authority.generation + 1,
        authority.revisionId,
      ]);
      database.run("INSERT OR REPLACE INTO workflow_slots VALUES (?, ?, ?)", [
        authority.runId,
        authority.runnerInstanceId,
        authority.generation + 1,
      ]);
      const continuation = { ...authority, generation: authority.generation + 1 };
      const applied = await Effect.runPromise(
        repository.markApplied(
          continuation,
          application?.wakeupId ?? "missing",
          "2026-09-01T20:02:00.000Z",
        ),
      );
      expect(applied.state).toBe("applied");
      expect(applied.appliedAt).toBe("2026-09-01T20:02:00.000Z");

      database.close(false);
      const reopened = new Database(path, { create: true, strict: true });
      reopened.run("PRAGMA foreign_keys = ON");
      const replacement = new SqliteDaemonGateRepository(reopened);
      expect(await Effect.runPromise(replacement.deferredApplications(authority.runId))).toEqual(
        [],
      );
      expect(await Effect.runPromise(replacement.deferredResults(authority.runId))).toEqual([
        application,
      ]);

      const repeated = await Effect.runPromise(
        replacement.markApplied(
          continuation,
          application?.wakeupId ?? "missing",
          "2026-09-01T20:03:00.000Z",
        ),
      );
      expect(repeated.appliedAt).toBe("2026-09-01T20:02:00.000Z");
      expect(reopened.query("SELECT count(*) AS count FROM gate_askings").get()).toEqual({
        count: 1,
      });
      expect(reopened.query("SELECT count(*) AS count FROM workflow_runs").get()).toEqual({
        count: 1,
      });
      reopened.close(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records terminal inability without scheduling another continuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-gate-terminal-"));
    const path = join(root, "kojo.db");
    try {
      const database = setup(path);
      const repository = new SqliteDaemonGateRepository(database);
      await Effect.runPromise(
        repository.createAskingAndSuspend(authority, {
          identity: {
            identityVersion: 1,
            runId: authority.runId,
            gatePath: "terminal",
            askingNumber: 1,
            escalationStage: 0,
          },
          token: "terminal-inability-token",
          projectId: "project-1",
          workflowName: "release",
          description: "Can this terminal Run continue?",
          actor: "operator",
          choices: ["approve", "reject"],
          deadline: "2026-09-02T00:00:00.000Z",
          expiryBranch: "fail",
          internalDeferredName: "gate/terminal/1",
          createdAt: "2026-09-01T20:00:00.000Z",
        }),
      );
      const receipt = await Effect.runPromise(
        repository.recordVerdictAndSchedule({
          dataIdentity: "data-1",
          requestId: "terminal-answer",
          canonicalRequest: "terminal-answer-content",
          token: "terminal-inability-token",
          choice: "approve",
          reason: "too late for the Run",
          answerer: "operator",
          now: "2026-09-01T20:01:00.000Z",
        }),
      );
      expect(receipt.asking).toMatchObject({ state: "recorded" });
      expect(receipt.asking.terminalInability).toBeUndefined();
      database.run("UPDATE workflow_runs SET state = 'failed' WHERE run_id = ?", [authority.runId]);
      await Effect.runPromise(repository.reconcileTerminalInabilities());
      expect(await Effect.runPromise(repository.byToken("terminal-inability-token"))).toMatchObject(
        { state: "recorded", terminalInability: "run-failed" },
      );
      expect(await Effect.runPromise(repository.deferredApplications(authority.runId))).toEqual([]);
      expect(database.query("SELECT count(*) AS count FROM workflow_runs").get()).toEqual({
        count: 1,
      });
      database.close(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
