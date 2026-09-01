import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SqliteResourceLeaseRepository } from "../../../../../src/contexts/project/adapters/SqliteResourceLeaseRepository.ts";

const authority = {
  projectId: "project-resource",
  runId: "run-resource",
  revisionId: "a".repeat(64),
  runnerInstanceId: "runner-current",
  claimGeneration: 2,
} as const;

const database = (): Database => {
  const db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run("CREATE TABLE projects (project_id TEXT PRIMARY KEY NOT NULL) STRICT");
  db.run("CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY NOT NULL) STRICT");
  db.run("INSERT INTO projects (project_id) VALUES (?)", [authority.projectId]);
  db.run("INSERT INTO workflow_runs (run_id) VALUES (?)", [authority.runId]);
  return db;
};

describe("SQLite Resource leases", () => {
  it("commits identity before acquisition and keeps each lifecycle state distinct", async () => {
    const db = database();
    const firstProcess = new SqliteResourceLeaseRepository(db);
    const intent = {
      ...authority,
      leaseId: "lease-sandbox",
      kind: "sandbox" as const,
      acquisitionKey: "run-resource/review/sandbox",
      requestedAt: "2026-09-01T10:00:00.000Z",
      detail: { branch: "kojo/run-resource" },
    };

    await Effect.runPromise(firstProcess.beginAcquisition(intent));
    await Effect.runPromise(firstProcess.beginAcquisition(intent));
    expect(await Effect.runPromise(firstProcess.byRun(authority.runId))).toHaveLength(1);

    const afterLostReply = new SqliteResourceLeaseRepository(db);
    expect((await Effect.runPromise(afterLostReply.byRun(authority.runId)))[0]?.state).toBe(
      "acquisition-intent",
    );

    await Effect.runPromise(
      afterLostReply.confirmAcquired(authority, intent.leaseId, "2026-09-01T10:00:01.000Z", {
        providerIdentity: "fixture-sandbox-1",
        locator: "/fixture/worktree",
      }),
    );
    await Effect.runPromise(
      afterLostReply.beginRelease(authority, intent.leaseId, "2026-09-01T10:00:02.000Z"),
    );
    expect((await Effect.runPromise(afterLostReply.byRun(authority.runId)))[0]?.state).toBe(
      "release-intent",
    );
    await Effect.runPromise(
      afterLostReply.confirmReleased(
        authority,
        intent.leaseId,
        "2026-09-01T10:00:03.000Z",
        "fixture provider counted one release",
      ),
    );
    expect((await Effect.runPromise(afterLostReply.byRun(authority.runId)))[0]?.state).toBe(
      "released",
    );
    db.close();
  });

  it("fences a stale holder and preserves dirty and unresolved Resources", async () => {
    const db = database();
    const repository = new SqliteResourceLeaseRepository(db);
    for (const [leaseId, kind] of [
      ["lease-worktree", "worktree"],
      ["lease-agent", "agent"],
    ] as const) {
      await Effect.runPromise(
        repository.beginAcquisition({
          ...authority,
          leaseId,
          kind,
          acquisitionKey: `${authority.runId}/${kind}`,
          requestedAt: "2026-09-01T10:00:00.000Z",
          detail: {},
        }),
      );
      await Effect.runPromise(
        repository.confirmAcquired(authority, leaseId, "2026-09-01T10:00:01.000Z", {
          providerIdentity: `fixture-${kind}`,
          locator: `/fixture/${kind}`,
        }),
      );
    }

    await expect(
      Effect.runPromise(
        repository.beginRelease(
          { ...authority, runnerInstanceId: "runner-stale", claimGeneration: 1 },
          "lease-worktree",
          "2026-09-01T10:00:02.000Z",
        ),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_AUTHORITY_LOST" });
    await Effect.runPromise(
      repository.preserve(
        authority,
        "lease-worktree",
        "2026-09-01T10:00:02.000Z",
        "fixture git reported dirty",
      ),
    );
    await Effect.runPromise(
      repository.unresolved(
        authority,
        "lease-agent",
        "2026-09-01T10:00:02.000Z",
        "the provider reply was lost",
      ),
    );
    expect(
      Object.fromEntries(
        (await Effect.runPromise(repository.byRun(authority.runId))).map((lease) => [
          lease.kind,
          lease.state,
        ]),
      ),
    ).toEqual({ agent: "unresolved", worktree: "preserved" });
    db.close();
  });
});
