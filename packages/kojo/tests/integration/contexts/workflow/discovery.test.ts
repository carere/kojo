import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import type { RevisionManifest } from "../../../../src/contexts/workflow/models/RevisionManifest.ts";

const databases: Database[] = [];

const manifest = (workflowName: string): RevisionManifest => ({
  formatVersion: 1,
  workflowName,
  entrySource: `workflows/${workflowName}.ts`,
  sources: [],
  assets: [],
  sharedConfiguration: [],
  packages: [],
  resolution: [],
  runtime: {
    packageId: "runtime",
    manifestHash: "a".repeat(64),
    runner: "./src/runner/main.ts",
    protocols: [1],
    requiredFeatures: [],
  },
  sharedEffect: { packageId: "effect", resolvedEntryHash: "b".repeat(64) },
  compatibility: {
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
    nativeContent: false,
  },
  dependencyEvidence: { lockfileHashes: [], resolutionInputHashes: [] },
});

const repository = (): SqliteProjectRepository => {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  return new SqliteProjectRepository(database);
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close(false);
});

describe("independent Factory Refresh and Workflow history", () => {
  it("isolates invalid siblings, holds admission, and keeps Removed revision history", async () => {
    const subject = repository();
    const revisionId = "1".repeat(64);
    const registered = await Effect.runPromise(
      subject.register({
        requestId: "request",
        requestBody: "body",
        dataIdentity: "data",
        location: "/tmp/project",
        observedAt: "2026-09-01T00:00:00.000Z",
        factory: {
          state: "available",
          refreshState: "current",
          workflows: [
            {
              workflowName: "valid",
              availability: "available",
              source: "/tmp/project/.kojo/workflows/valid.ts",
              revision: {
                revisionId,
                packageGraphId: "2".repeat(64),
                manifest: manifest("valid"),
                publishedPath: `/data/revisions/${revisionId}`,
              },
            },
            {
              workflowName: "invalid",
              availability: "invalid",
              source: "/tmp/project/.kojo/workflows/invalid.ts",
              sourceFault: "declares a different Workflow name",
            },
          ],
        },
      }),
    );
    expect(
      await Effect.runPromise(subject.admissibleRevision(registered.project.projectId, "valid")),
    ).toBe(revisionId);
    expect(await Effect.runPromise(subject.workflows)).toMatchObject([
      { workflowName: "invalid", availability: "invalid" },
      { workflowName: "valid", availability: "available", currentRevisionId: revisionId },
    ]);

    await Effect.runPromise(subject.markRefreshPending(registered.project.projectId));
    await expect(
      Effect.runPromise(subject.admissibleRevision(registered.project.projectId, "valid")),
    ).rejects.toMatchObject({ code: "REFRESH_PENDING" });

    await Effect.runPromise(
      subject.refresh(
        registered.project.projectId,
        { factoryState: "available", workflows: [], fault: "validator process stopped" },
        "failed",
        "2026-09-01T00:01:00.000Z",
      ),
    );
    await expect(
      Effect.runPromise(subject.admissibleRevision(registered.project.projectId, "valid")),
    ).rejects.toMatchObject({ code: "REFRESH_FAILED" });
    expect(await Effect.runPromise(subject.workflows)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workflowName: "valid", currentRevisionId: revisionId }),
      ]),
    );

    await Effect.runPromise(
      subject.refresh(
        registered.project.projectId,
        {
          factoryState: "available",
          workflows: [
            {
              workflowName: "invalid",
              availability: "invalid",
              source: "/tmp/project/.kojo/workflows/invalid.ts",
              sourceFault: "still invalid",
            },
          ],
        },
        "current",
        "2026-09-01T00:02:00.000Z",
      ),
    );
    expect(await Effect.runPromise(subject.workflows)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowName: "valid",
          availability: "removed",
          currentRevisionId: revisionId,
        }),
        expect.objectContaining({ workflowName: "invalid", availability: "invalid" }),
      ]),
    );
  });
});
