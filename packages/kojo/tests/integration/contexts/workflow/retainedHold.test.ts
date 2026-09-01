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
