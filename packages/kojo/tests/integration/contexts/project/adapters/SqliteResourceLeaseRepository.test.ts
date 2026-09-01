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

const allocation = (leaseId: string) => ({
  providerIdentity: `kojo-resource:${leaseId}`,
  inspectionLocator: `/fixture/inspection/${leaseId}.json`,
});

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

    await Effect.runPromise(firstProcess.beginAcquisition(intent, allocation(intent.leaseId)));
    await Effect.runPromise(firstProcess.beginAcquisition(intent, allocation(intent.leaseId)));
    expect(await Effect.runPromise(firstProcess.byRun(authority.runId))).toHaveLength(1);

    const afterLostReply = new SqliteResourceLeaseRepository(db);
    expect((await Effect.runPromise(afterLostReply.byRun(authority.runId)))[0]?.state).toBe(
      "acquisition-intent",
    );

    await Effect.runPromise(
      afterLostReply.confirmAcquired(authority, intent.leaseId, "2026-09-01T10:00:01.000Z", {
        providerIdentity: allocation(intent.leaseId).providerIdentity,
        locator: "/fixture/worktree",
      }),
    );
    await Effect.runPromise(
      afterLostReply.confirmAcquired(authority, intent.leaseId, "2026-09-01T10:00:01.000Z", {
        providerIdentity: allocation(intent.leaseId).providerIdentity,
        locator: "/fixture/worktree",
      }),
    );
    await expect(
      Effect.runPromise(
        afterLostReply.confirmAcquired(authority, intent.leaseId, "2026-09-01T10:00:09.000Z", {
          providerIdentity: allocation(intent.leaseId).providerIdentity,
          locator: "/fixture/forged",
        }),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
    await Effect.runPromise(
      afterLostReply.beginRelease(authority, intent.leaseId, "2026-09-01T10:00:02.000Z"),
    );
    await Effect.runPromise(
      afterLostReply.beginRelease(authority, intent.leaseId, "2026-09-01T10:00:02.000Z"),
    );
    await expect(
      Effect.runPromise(
        afterLostReply.beginRelease(authority, intent.leaseId, "2026-09-01T10:00:09.000Z"),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
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
    await Effect.runPromise(
      afterLostReply.confirmReleased(
        authority,
        intent.leaseId,
        "2026-09-01T10:00:03.000Z",
        "fixture provider counted one release",
      ),
    );
    await expect(
      Effect.runPromise(
        afterLostReply.confirmReleased(
          authority,
          intent.leaseId,
          "2026-09-01T10:00:09.000Z",
          "forged evidence",
        ),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
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
        repository.beginAcquisition(
          {
            ...authority,
            leaseId,
            kind,
            acquisitionKey: `${authority.runId}/${kind}`,
            requestedAt: "2026-09-01T10:00:00.000Z",
            detail: {},
          },
          allocation(leaseId),
        ),
      );
      await Effect.runPromise(
        repository.confirmAcquired(authority, leaseId, "2026-09-01T10:00:01.000Z", {
          providerIdentity: allocation(leaseId).providerIdentity,
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
      repository.preserve(
        authority,
        "lease-worktree",
        "2026-09-01T10:00:02.000Z",
        "fixture git reported dirty",
      ),
    );
    await expect(
      Effect.runPromise(
        repository.preserve(
          authority,
          "lease-worktree",
          "2026-09-01T10:00:09.000Z",
          "forged preservation",
        ),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
    await Effect.runPromise(
      repository.unresolved(
        authority,
        "lease-agent",
        "2026-09-01T10:00:02.000Z",
        "the provider reply was lost",
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
    await expect(
      Effect.runPromise(
        repository.unresolved(
          authority,
          "lease-agent",
          "2026-09-01T10:00:09.000Z",
          "forged observation",
        ),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_STATE_CONFLICT" });
    expect(
      Object.fromEntries(
        (await Effect.runPromise(repository.byRun(authority.runId))).map((lease) => [
          lease.kind,
          lease.state,
        ]),
      ),
    ).toEqual({ agent: "unresolved", worktree: "preserved" });
    expect(await Effect.runPromise(repository.byRun(authority.runId))).toEqual(
      expect.arrayContaining([expect.objectContaining({ observedAt: "2026-09-01T10:00:02.000Z" })]),
    );
    db.close();
  });

  it("requires the exact durable termination proof before bounded recovery", async () => {
    const db = database();
    const repository = new SqliteResourceLeaseRepository(db);
    const intent = {
      ...authority,
      leaseId: "lease-recovery",
      kind: "worktree" as const,
      acquisitionKey: "run-resource/recovery/worktree",
      requestedAt: "2026-09-01T10:00:00.000Z",
      detail: { branch: "kojo/run-resource" },
    };
    const committed = {
      ...allocation(intent.leaseId),
      providerLocator: "/fixture/worktree-recovery",
    };
    await Effect.runPromise(repository.beginAcquisition(intent, committed));
    await Effect.runPromise(
      repository.confirmAcquired(authority, intent.leaseId, "2026-09-01T10:00:01.000Z", {
        providerIdentity: committed.providerIdentity,
        locator: committed.providerLocator,
      }),
    );
    const proof = {
      projectId: authority.projectId,
      priorRunnerInstanceId: authority.runnerInstanceId,
      terminationConfirmedAt: "2026-09-01T10:00:02.000Z",
    } as const;

    await expect(
      Effect.runPromise(repository.pendingForTerminatedRunner(proof, 10)),
    ).rejects.toMatchObject({ code: "RESOURCE_AUTHORITY_LOST" });
    await Effect.runPromise(repository.confirmRunnerTermination(proof));
    await expect(
      Effect.runPromise(
        repository.pendingForTerminatedRunner(
          { ...proof, terminationConfirmedAt: "2026-09-01T10:00:03.000Z" },
          10,
        ),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_AUTHORITY_LOST" });

    const before = (await Effect.runPromise(repository.byRun(authority.runId)))[0];
    await Effect.runPromise(
      repository.reconcileTerminatedRunner(proof, [
        {
          leaseId: intent.leaseId,
          outcome: "preserved",
          reason: "the exact worktree is dirty",
        },
      ]),
    );
    const after = (await Effect.runPromise(repository.byRun(authority.runId)))[0];
    expect(after).toMatchObject({
      state: "preserved",
      acquisitionKey: before?.acquisitionKey,
      providerIdentity: before?.providerIdentity,
      providerLocator: before?.providerLocator,
      detail: before?.detail,
    });
    db.close();
  });
});
