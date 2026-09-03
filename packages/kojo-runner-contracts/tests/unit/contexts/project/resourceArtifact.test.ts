import { describe, expect, it } from "vitest";
import { decodeRunnerFrame } from "../../../../src/contexts/project/codecs/frame.ts";
import { MAX_ARTIFACT_BYTES } from "../../../../src/contexts/project/contracts/artifact.ts";

const addressed = {
  version: 1,
  requestId: "request-1",
  daemonInstanceId: "daemon-1",
  runnerInstanceId: "runner-1",
  runId: "run-1",
  revisionId: "a".repeat(64),
  claimGeneration: 1,
} as const;

describe("Resource and Artifact frames", () => {
  it("decodes a closed Resource acquisition intent", () => {
    const decoded = decodeRunnerFrame({
      ...addressed,
      kind: "BeginResourceAcquisition",
      body: {
        resourceVersion: 1,
        leaseId: "lease-1",
        kind: "sandbox",
        acquisitionKey: "run-1/sandbox-1",
        requestedAt: "2026-09-01T10:00:00.000Z",
        detail: { branch: "kojo/run-1" },
      },
    });
    expect(decoded.ok).toBe(true);
  });

  it("refuses an Artifact over the total publication bound", () => {
    const decoded = decodeRunnerFrame({
      ...addressed,
      kind: "BeginArtifact",
      body: {
        artifactVersion: 1,
        transferId: "transfer-1",
        name: "session.jsonl",
        mediaType: "application/x-ndjson",
        totalSize: MAX_ARTIFACT_BYTES + 1,
        sha256: "a".repeat(64),
      },
    });
    expect(decoded.ok).toBe(false);
  });

  it("refuses unknown Resource detail fields and oversized chunks", () => {
    const resource = decodeRunnerFrame({
      ...addressed,
      kind: "BeginResourceAcquisition",
      body: {
        resourceVersion: 1,
        leaseId: "lease-1",
        kind: "agent",
        acquisitionKey: "run-1/agent-1",
        requestedAt: "2026-09-01T10:00:00.000Z",
        detail: {},
        spendGrant: "allow",
      },
    });
    const artifact = decodeRunnerFrame({
      ...addressed,
      kind: "WriteArtifactChunk",
      body: {
        artifactChunkVersion: 1,
        transferId: "transfer-1",
        ordinal: 0,
        totalSize: 300_000,
        sha256: "a".repeat(64),
        data: new Uint8Array(300_000).toBase64(),
      },
    });
    expect(resource.ok).toBe(false);
    expect(artifact.ok).toBe(false);
  });
});
