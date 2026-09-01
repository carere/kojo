import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const admit = (
  repository: SqliteRunRepository,
  projectId: string,
  key: string,
  sequence: number,
  revisionId: string,
) =>
  Effect.runPromise(
    repository.admit({
      dataIdentity: "retained-hold-data",
      requestId: `${projectId}:${key}`,
      canonicalRequest: JSON.stringify([projectId, key]),
      projectId,
      workflowName: "review",
      idempotencyKey: key,
      payload: { key },
      revisionId,
      packageGraphId: `graph-${revisionId}`,
      admittedAt: new Date(sequence).toISOString(),
    }),
  );

describe("retained content recovery hold", () => {
  it("migrates old Run hold checks without changing existing rows", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-run-hold-migration-"));
    roots.push(root);
    const database = new Database(join(root, "kojo.db"), { create: true, strict: true });
    database.run(`
      CREATE TABLE project_workflows (
        project_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        PRIMARY KEY (project_id, workflow_name)
      ) STRICT
    `);
    database.run("CREATE TABLE workflow_revisions (revision_id TEXT PRIMARY KEY NOT NULL) STRICT");
    database.run(`
      CREATE TABLE workflow_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        package_graph_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'executing', 'suspended', 'succeeded', 'failed', 'cancelled')),
        admission_sequence INTEGER NOT NULL UNIQUE,
        admitted_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(project_id, workflow_name, idempotency_key),
        FOREIGN KEY (project_id, workflow_name) REFERENCES project_workflows(project_id, workflow_name),
        FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE workflow_run_holds (
        run_id TEXT PRIMARY KEY NOT NULL,
        code TEXT NOT NULL CHECK(code IN (
          'RETAINED_CONTENT_MISSING',
          'RETAINED_CONTENT_CORRUPT',
          'RETAINED_HOST_INCOMPATIBLE',
          'RETAINED_BUN_INCOMPATIBLE',
          'RETAINED_EFFECT_INCOMPATIBLE',
          'RETAINED_PROTOCOL_INCOMPATIBLE'
        )),
        detail TEXT NOT NULL,
        remedy TEXT NOT NULL,
        fault_json TEXT NOT NULL,
        held_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run("INSERT INTO project_workflows VALUES ('project-old', 'review')");
    database.run("INSERT INTO workflow_revisions VALUES ('revision-old')");
    database.run(`
      INSERT INTO workflow_runs VALUES (
        'run-old', 'project-old', 'review', 'old', '{}', 'revision-old', 'graph-old',
        'queued', 1, '2026-09-01T00:00:00.000Z', NULL, NULL
      )
    `);
    database.run(`
      INSERT INTO workflow_run_holds VALUES (
        'run-old', 'RETAINED_CONTENT_MISSING', 'old detail', 'old remedy', '{}',
        '2026-09-01T00:00:01.000Z'
      )
    `);

    new SqliteRunRepository(database);
    database.close(false);

    const reopened = new Database(join(root, "kojo.db"), { strict: true });
    reopened.run("PRAGMA foreign_keys = ON");
    reopened.run("UPDATE workflow_runs SET state = 'held' WHERE run_id = 'run-old'");
    reopened.run("DELETE FROM workflow_run_holds WHERE run_id = 'run-old'");
    reopened.run(`
      INSERT INTO workflow_run_holds VALUES (
        'run-old', 'PROJECT_RECOVERY_REQUIRED', 'new detail', 'new remedy', '{}',
        '2026-09-01T00:00:02.000Z'
      )
    `);

    expect(
      reopened
        .query<{ readonly state: string }, []>(
          "SELECT state FROM workflow_runs WHERE run_id = 'run-old'",
        )
        .get(),
    ).toEqual({ state: "held" });
    expect(
      reopened
        .query<{ readonly code: string }, []>(
          "SELECT code FROM workflow_run_holds WHERE run_id = 'run-old'",
        )
        .get(),
    ).toEqual({ code: "PROJECT_RECOVERY_REQUIRED" });
    expect(
      reopened.query<{ readonly integrity_check: string }, []>("PRAGMA integrity_check").get(),
    ).toEqual({ integrity_check: "ok" });
    expect(reopened.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all()).toEqual(
      [],
    );
    reopened.close(false);
  });

  it("persists the exact fault and keeps unrelated revisions eligible after reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-retained-hold-"));
    roots.push(root);
    const path = join(root, "kojo.db");
    const firstDatabase = new Database(path, { create: true, strict: true });
    firstDatabase.run(
      "CREATE TABLE project_workflows (project_id TEXT NOT NULL, workflow_name TEXT NOT NULL, PRIMARY KEY (project_id, workflow_name)) STRICT",
    );
    firstDatabase.run(
      "CREATE TABLE workflow_revisions (revision_id TEXT PRIMARY KEY NOT NULL) STRICT",
    );
    for (const projectId of ["project-a", "project-b"]) {
      firstDatabase.run(
        "INSERT INTO project_workflows (project_id, workflow_name) VALUES (?, 'review')",
        [projectId],
      );
    }
    for (const revisionId of ["revision-a", "revision-b", "revision-c"]) {
      firstDatabase.run("INSERT INTO workflow_revisions (revision_id) VALUES (?)", [revisionId]);
    }
    const first = new SqliteRunRepository(firstDatabase);
    const damaged = await admit(first, "project-a", "damaged", 1, "revision-a");
    await admit(first, "project-a", "sibling", 2, "revision-b");
    await admit(first, "project-b", "other", 3, "revision-c");
    const reserved = await Effect.runPromise(
      first.reserveNext("reservation-a", new Date(4).toISOString()),
    );
    expect(reserved?.run.runId).toBe(damaged.run.runId);
    await Effect.runPromise(
      first.holdReserved(
        "reservation-a",
        {
          code: "RETAINED_EFFECT_INCOMPATIBLE",
          detail: "the retained graph resolves a second Effect",
          remedy: "Restore the exact accepted package graph.",
          retry: "after-compatible-release",
          scope: {
            projectId: "project-a",
            workflowName: "review",
            revisionId: "revision-a",
            packageGraphId: "graph-revision-a",
          },
        },
        new Date(5).toISOString(),
      ),
    );
    firstDatabase.close(false);

    const reopenedDatabase = new Database(path, { strict: true });
    const reopened = new SqliteRunRepository(reopenedDatabase);
    expect(await Effect.runPromise(reopened.read(damaged.run.runId))).toMatchObject({
      state: "held",
      queueReason: "pinned-content",
      executionFault: {
        code: "RETAINED_EFFECT_INCOMPATIBLE",
        retry: "after-compatible-release",
        scope: { revisionId: "revision-a", packageGraphId: "graph-revision-a" },
      },
    });
    const eligible = [];
    for (let index = 0; index < 2; index += 1) {
      const claimed = await Effect.runPromise(
        reopened.claimNext(`runner-${index}`, new Date(6 + index).toISOString()),
      );
      if (claimed === undefined) throw new Error("an unrelated Run was not eligible");
      eligible.push(claimed.run.idempotencyKey);
      await Effect.runPromise(
        reopened.completeRun(claimed.authority, "succeeded", new Date(10 + index).toISOString()),
      );
    }
    expect(eligible.toSorted()).toEqual(["other", "sibling"]);
    reopenedDatabase.close(false);
  });
});
