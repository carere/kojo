import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { InMemoryUpgradePreflightRepository } from "../../../../../src/contexts/daemon/adapters/InMemoryUpgradePreflightRepository.ts";
import type { CheckedManagedReleaseManifest } from "../../../../../src/contexts/daemon/models/ManagedRelease.ts";
import type { UpgradeEvidence } from "../../../../../src/contexts/daemon/models/ManagedUpgrade.ts";
import { ManagedUpgradePreflight } from "../../../../../src/contexts/daemon/services/ManagedUpgradePreflight.ts";
import type { RevisionManifest } from "../../../../../src/contexts/workflow/models/RevisionManifest.ts";

const revision = (protocols: ReadonlyArray<number> = [1]): RevisionManifest => ({
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
    protocols,
    requiredFeatures: [],
  },
  sharedEffect: { packageId: "effect", resolvedEntryHash: "b".repeat(64) },
  compatibility: {
    bun: "1.3.14",
    os: process.platform,
    arch: process.arch,
    nativeContent: false,
  },
  dependencyEvidence: { lockfileHashes: [], resolutionInputHashes: [] },
});

const candidate = (
  changes: Partial<CheckedManagedReleaseManifest> = {},
): CheckedManagedReleaseManifest => ({
  formatVersion: 2,
  releaseId: "kojo-candidate",
  kojoVersion: "2.0.0",
  bunVersion: Bun.version,
  createdAt: "2026-09-01T12:00:00.000Z",
  host: { os: process.platform, arch: process.arch },
  compatibility: {
    dataFormats: [1],
    revisionFormats: [1],
    runnerProtocols: [1],
    requiredFeatures: [],
  },
  files: [],
  ...changes,
});

const evidence = (changes: Partial<UpgradeEvidence> = {}): UpgradeEvidence => ({
  dataIdentity: "daemon-data",
  dataFormat: 1,
  retainedSetHash: "1".repeat(64),
  requirements: [
    {
      kind: "current-workflow",
      ownerId: '["project","review"]',
      revisionId: "revision-one",
    },
    {
      kind: "retained-run",
      ownerId: "run-terminal",
      revisionId: "revision-one",
      state: "succeeded",
    },
    {
      kind: "active-reader",
      ownerId: "validation-reader",
      revisionId: "revision-one",
    },
  ],
  revisions: [
    {
      revisionId: "revision-one",
      packageGraphId: "graph-one",
      manifest: revision(),
      faults: [],
    },
  ],
  currentWorkflowFaults: [],
  ...changes,
});

describe("managed upgrade preflight", () => {
  it("checks current Workflows, terminal retained Runs, and readers without executing a Workflow", async () => {
    let captures = 0;
    const repository = new InMemoryUpgradePreflightRepository(() => {
      captures += 1;
      return evidence();
    });

    const result = await Effect.runPromise(
      new ManagedUpgradePreflight(repository, () => Date.parse("2026-09-01T12:00:00.000Z")).check({
        candidate: candidate(),
        sourceReleaseId: "kojo-source",
      }),
    );

    expect(result.report).toMatchObject({
      outcome: "staged",
      checked: {
        currentWorkflows: 1,
        retainedRuns: 1,
        terminalRuns: 1,
        readers: 1,
        revisions: 1,
      },
    });
    expect(captures).toBe(2);
  });

  it("refuses a candidate protocol regression and keeps a corrupt retained fault scoped", async () => {
    const retained = evidence({
      revisions: [
        {
          revisionId: "revision-one",
          packageGraphId: "graph-one",
          manifest: revision([7]),
          faults: [
            {
              code: "CONTENT_CORRUPT",
              path: "manifest.json",
              detail: "the retained manifest bytes are corrupt",
              remedy: "Restore this exact manifest.",
            },
          ],
        },
      ],
    });

    const result = await Effect.runPromise(
      new ManagedUpgradePreflight(new InMemoryUpgradePreflightRepository(retained)).check({
        candidate: candidate(),
        sourceReleaseId: "kojo-source",
      }),
    );

    expect(result.report.outcome).toBe("incompatible");
    expect(result.report.compatibilityFaults[0]).toMatchObject({
      code: "RUNNER_PROTOCOL_REGRESSION",
      revisionId: "revision-one",
    });
    expect(result.report.existingFaults[0]).toMatchObject({
      code: "CONTENT_CORRUPT",
      revisionId: "revision-one",
      affectedScope: expect.arrayContaining([
        'current-workflow:["project","review"]',
        "retained-run:run-terminal",
      ]),
    });
  });

  it("refuses when the retained set changes during the check", async () => {
    let capture = 0;
    const repository = new InMemoryUpgradePreflightRepository(() => {
      capture += 1;
      return evidence({ retainedSetHash: (capture === 1 ? "1" : "2").repeat(64) });
    });

    const result = await Effect.runPromise(
      new ManagedUpgradePreflight(repository).check({
        candidate: candidate(),
        sourceReleaseId: "kojo-source",
      }),
    );

    expect(result.report.outcome).toBe("incompatible");
    expect(result.report.compatibilityFaults).toContainEqual(
      expect.objectContaining({ code: "RETAINED_SET_CHANGED" }),
    );
  });

  it("refuses unknown evidence and recorded Bun or Host regressions", async () => {
    const unknown = await Effect.runPromise(
      new ManagedUpgradePreflight(
        new InMemoryUpgradePreflightRepository(
          evidence({
            revisions: [
              {
                revisionId: "revision-one",
                packageGraphId: "graph-one",
                faults: [],
                inspectionFault: "the retained manifest cannot be decoded",
              },
            ],
          }),
        ),
      ).check({ candidate: candidate(), sourceReleaseId: "kojo-source" }),
    );
    expect(unknown.report.compatibilityFaults).toContainEqual(
      expect.objectContaining({ code: "COMPATIBILITY_UNKNOWN" }),
    );

    const incompatibleHost = process.platform === "darwin" ? "linux" : "darwin";
    const regressed = await Effect.runPromise(
      new ManagedUpgradePreflight(new InMemoryUpgradePreflightRepository(evidence())).check({
        candidate: candidate({
          bunVersion: "1.0.0",
          host: { os: incompatibleHost, arch: process.arch },
        }),
        sourceReleaseId: "kojo-source",
      }),
    );
    expect(regressed.report.compatibilityFaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BUN_REGRESSION" }),
        expect.objectContaining({ code: "HOST_REGRESSION" }),
      ]),
    );
  });

  it("requires and validates one candidate, data, migration, and retained-set plan", async () => {
    const repository = new InMemoryUpgradePreflightRepository(evidence());
    let now = Date.parse("2026-09-01T12:00:00.000Z");
    const service = new ManagedUpgradePreflight(repository, () => now);
    const noRollback = candidate({
      compatibility: {
        dataFormats: [2],
        revisionFormats: [1],
        runnerProtocols: [1],
        requiredFeatures: [],
      },
      migration: {
        fromDataFormat: 1,
        toDataFormat: 2,
        rollback: "lost",
        description: "Convert operation receipts to data format 2",
      },
    });

    const disclosed = await Effect.runPromise(
      service.check({ candidate: noRollback, sourceReleaseId: "kojo-source" }),
    );
    expect(disclosed.report).toMatchObject({
      outcome: "approval-required",
      rollbackApproval: "required",
      plan: {
        dataIdentity: "daemon-data",
        candidateReleaseId: "kojo-candidate",
        expectedStateVersion: "1".repeat(64),
      },
    });
    expect(disclosed.approvalToken).toBeDefined();

    const approved = await Effect.runPromise(
      service.check({
        candidate: noRollback,
        sourceReleaseId: "kojo-source",
        approvalToken: disclosed.approvalToken as string,
      }),
    );
    expect(approved.report).toMatchObject({ outcome: "staged", rollbackApproval: "approved" });

    now = Date.parse("2026-09-01T12:20:00.000Z");
    const replayed = await Effect.runPromise(
      service.check({
        candidate: noRollback,
        sourceReleaseId: "kojo-source",
        approvalToken: disclosed.approvalToken as string,
      }),
    );
    expect(replayed.report).toMatchObject({ outcome: "staged", rollbackApproval: "approved" });
    expect(replayed.report.plan?.approvedAt).toBe(approved.report.plan?.approvedAt);

    const rechecked = await Effect.runPromise(
      service.check({ candidate: noRollback, sourceReleaseId: "kojo-source" }),
    );
    expect(rechecked).toMatchObject({
      report: { outcome: "staged", rollbackApproval: "approved" },
    });
    expect(rechecked.approvalToken).toBeUndefined();
  });
});
