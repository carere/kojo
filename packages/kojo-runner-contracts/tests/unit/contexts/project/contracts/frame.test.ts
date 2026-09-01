import { describe, expect, it } from "vitest";
import { decodeRunnerFrame } from "../../../../../src/contexts/project/codecs/frame.ts";
import {
  decodeFrameLength,
  decodeLengthPrefixedFrame,
  encodeLengthPrefixedFrame,
} from "../../../../../src/contexts/project/codecs/framing.ts";
import { MAX_CONTROL_FRAME_BYTES } from "../../../../../src/contexts/project/contracts/frame.ts";
import { RUNNER_OPERATION_KINDS } from "../../../../../src/contexts/project/contracts/operations.ts";

const sha256 = "a".repeat(64);
const address = {
  version: 1,
  requestId: "request_1",
  daemonInstanceId: "daemon_1",
  runnerInstanceId: "runner_1",
} as const;

const execution = {
  ...address,
  kind: "ExecuteRun",
  runId: "run_1",
  revisionId: sha256,
  claimGeneration: 1,
  body: {
    executionVersion: 1,
    workflowName: "example",
    payload: null,
    recordedResults: {},
    deferredResults: {},
    scheduledWakeups: {},
  },
} as const;

describe("Runner contract golden fixtures", () => {
  it("accepts the version 1 handshake and execution envelope", () => {
    const hello = decodeRunnerFrame({
      ...address,
      kind: "Hello",
      body: {
        helloVersion: 1,
        connectionSecret: "b".repeat(64),
        packageGraphId: sha256,
        projectId: "project_1",
        supportedProtocols: [1],
        requiredFeatures: [],
      },
    });
    expect(hello.ok).toBe(true);
    expect(decodeRunnerFrame(execution).ok).toBe(true);
  });

  it("lists every protocol operation as an explicit literal", () => {
    expect(RUNNER_OPERATION_KINDS).toHaveLength(43);
    expect(new Set(RUNNER_OPERATION_KINDS).size).toBe(RUNNER_OPERATION_KINDS.length);
  });

  it.each([
    ["changed field name", { ...execution, requestID: "request_1", requestId: undefined }],
    ["missing version", { ...execution, version: undefined }],
    ["unknown kind", { ...execution, kind: "DoAnything" }],
    ["extra field", { ...execution, extra: true }],
    ["invalid number", { ...execution, claimGeneration: Number.POSITIVE_INFINITY }],
    ["invalid identity", { ...execution, runId: "" }],
  ])("rejects %s", (_name, fixture) => {
    expect(decodeRunnerFrame(fixture).ok).toBe(false);
  });

  it("requires execution authority only on execution mutations", () => {
    expect(decodeRunnerFrame({ ...execution, kind: "Health" }).ok).toBe(false);
    const {
      runId: _runId,
      revisionId: _revisionId,
      claimGeneration: _claim,
      ...withoutAuthority
    } = execution;
    expect(decodeRunnerFrame(withoutAuthority).ok).toBe(false);
  });

  it("accepts a bounded Artifact chunk and rejects a larger chunk", () => {
    const chunk = {
      ...execution,
      kind: "WriteArtifactChunk",
      body: {
        artifactChunkVersion: 1,
        transferId: "transfer_1",
        ordinal: 0,
        totalSize: 3,
        sha256,
        data: "YWJj",
      },
    } as const;
    expect(decodeRunnerFrame(chunk).ok).toBe(true);
    expect(
      decodeRunnerFrame({
        ...chunk,
        body: { ...chunk.body, data: "YWFh".repeat(87_382) },
      }).ok,
    ).toBe(false);
  });
});

describe("Runner byte framing", () => {
  it("writes and reads a four-byte unsigned big-endian length", () => {
    const encoded = encodeLengthPrefixedFrame(execution);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const declared = new DataView(encoded.value.buffer).getUint32(0, false);
    expect(declared).toBe(encoded.value.byteLength - 4);
    expect(decodeLengthPrefixedFrame(encoded.value)).toEqual({ ok: true, value: execution });
  });

  it("rejects an oversized declared length before JSON parsing", () => {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, MAX_CONTROL_FRAME_BYTES + 1, false);
    expect(decodeFrameLength(prefix).ok).toBe(false);
  });

  it("rejects length mismatch and malformed UTF-8", () => {
    const mismatch = new Uint8Array([0, 0, 0, 2, 123]);
    expect(decodeLengthPrefixedFrame(mismatch).ok).toBe(false);
    const malformed = new Uint8Array([0, 0, 0, 1, 0xff]);
    expect(decodeLengthPrefixedFrame(malformed).ok).toBe(false);
  });
});
