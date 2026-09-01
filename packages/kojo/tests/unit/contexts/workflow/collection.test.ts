import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { layer } from "../../../../src/contexts/workflow/adapters/InMemoryRevisionRepository.ts";
import type { RevisionManifest } from "../../../../src/contexts/workflow/models/RevisionManifest.ts";
import { RevisionRepository } from "../../../../src/contexts/workflow/ports/RevisionRepository.ts";

const manifest: RevisionManifest = {
  formatVersion: 1,
  workflowName: "review",
  entrySource: "workflows/review.ts",
  sources: [],
  assets: [],
  sharedConfiguration: [],
  packages: [],
  resolution: [],
  runtime: {
    packageId: "runtime",
    manifestHash: "a".repeat(64),
    runner: "src/runner/main.ts",
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
};

const revisionId = "c".repeat(64);
const repositoryLayer = layer([{ revisionId, packageGraphId: "d".repeat(64), manifest }]);

describe("Workflow Revision collection", () => {
  it.effect("keeps a loaded registration protected until disposal evidence", () =>
    Effect.gen(function* () {
      const repository = yield* RevisionRepository;
      yield* repository.acquireReader({
        readerId: "loaded-review",
        revisionId,
        kind: "loaded",
        runnerInstanceId: "runner-1",
        acquiredAt: "2026-09-01T00:00:00.000Z",
      });

      expect((yield* repository.collect(revisionId, "2026-09-03T00:00:00.000Z")).state).toBe(
        "protected",
      );
      const wrongExit = yield* Effect.flip(
        repository.releaseReader("loaded-review", {
          kind: "process-exit",
          runnerInstanceId: "runner-2",
          confirmedAt: "2026-09-03T00:00:00.000Z",
        }),
      );
      expect(wrongExit.code).toBe("READER_RELEASE_REFUSED");
      expect(
        (yield* repository.details(revisionId, "2026-09-03T00:00:00.000Z")).protections,
      ).toContainEqual(expect.objectContaining({ reason: "loaded-registration" }));

      yield* repository.confirmProcessExit("runner-1", "2026-09-03T00:00:00.000Z");
      const grace = yield* repository.collect(revisionId, "2026-09-03T23:59:59.999Z");
      expect(grace).toEqual({
        revisionId,
        state: "grace",
        eligibleAt: "2026-09-04T00:00:00.000Z",
      });
      expect((yield* repository.collect(revisionId, "2026-09-04T00:00:00.000Z")).state).toBe(
        "collected",
      );
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("restarts grace after a reader enters before collection", () =>
    Effect.gen(function* () {
      const repository = yield* RevisionRepository;
      expect((yield* repository.collect(revisionId, "2026-09-01T00:00:00.000Z")).state).toBe(
        "grace",
      );
      yield* repository.acquireReader({
        readerId: "validator-reader",
        revisionId,
        kind: "active",
        acquiredAt: "2026-09-01T23:59:59.000Z",
      });
      expect((yield* repository.collect(revisionId, "2026-09-02T00:00:01.000Z")).state).toBe(
        "protected",
      );
      yield* repository.releaseReader("validator-reader", {
        kind: "disposed",
        confirmedAt: "2026-09-02T00:00:01.000Z",
      });
      expect((yield* repository.collect(revisionId, "2026-09-03T00:00:00.999Z")).state).toBe(
        "grace",
      );
    }).pipe(Effect.provide(repositoryLayer)),
  );
});
