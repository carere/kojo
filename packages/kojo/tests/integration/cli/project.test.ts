import { describe, expect, it } from "vitest";
import { revisionLines } from "../../../src/cli/project.ts";
import type { RevisionDetails } from "../../../src/contexts/workflow/models/RevisionMaintenance.ts";

const revisionId = "a".repeat(64);
const packageGraphId = "b".repeat(64);

const details: RevisionDetails = {
  revisionId,
  packageGraphId,
  manifest: {
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
      manifestHash: "c".repeat(64),
      runner: "runner.ts",
      protocols: [1],
      requiredFeatures: [],
    },
    sharedEffect: { packageId: "effect", resolvedEntryHash: "d".repeat(64) },
    compatibility: {
      bun: Bun.version,
      os: process.platform,
      arch: process.arch,
      nativeContent: false,
    },
    dependencyEvidence: { lockfileHashes: [], resolutionInputHashes: [] },
  },
  packages: [],
  dependentRuns: [{ runId: "run-one", state: "suspended" }],
  activeReaders: [
    {
      readerId: "registration-one",
      kind: "loaded",
      runnerInstanceId: "runner-one",
      acquiredAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  protections: [{ reason: "retained-run", ownerId: "run-one", detail: "retained Run protection" }],
  faults: [
    {
      code: "CONTENT_MISSING",
      path: "factory/sources/workflows/review.ts",
      detail: "source missing",
      remedy: "restore exact bytes",
    },
  ],
  collection: { state: "grace", eligibleAt: "2026-09-02T00:00:00.000Z" },
};

describe("Project revision CLI detail", () => {
  it("shows identity, manifest, packages, Runs, readers, protections, faults, and eligibility", () => {
    const output = revisionLines(details).join("\n");
    expect(output).toContain(`Workflow Revision ${revisionId}`);
    expect(output).toContain(`Package graph ${packageGraphId}`);
    expect(output).toContain("Manifest");
    expect(output).toContain("Packages");
    expect(output).toContain("run-one");
    expect(output).toContain("registration-one");
    expect(output).toContain("retained-run");
    expect(output).toContain("CONTENT_MISSING");
    expect(output).toContain("2026-09-02T00:00:00.000Z");
  });
});
