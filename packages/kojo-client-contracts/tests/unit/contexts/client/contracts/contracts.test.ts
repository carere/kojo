import { describe, expect, it } from "vitest";
import { decodeBootstrapResponse } from "../../../../../src/contexts/client/contracts/bootstrap.ts";
import { decodeMutationEnvelope } from "../../../../../src/contexts/client/contracts/mutation.ts";
import { decodeObservationSnapshot } from "../../../../../src/contexts/client/contracts/observation.ts";
import {
  decodeOperationReceipt,
  decodeOperationRefusal,
} from "../../../../../src/contexts/client/contracts/operation.ts";
import {
  decodePageMetadata,
  decodePaginationRequest,
} from "../../../../../src/contexts/client/contracts/pagination.ts";

const target = { identityVersion: 1, kind: "project", parts: ["project_1"] } as const;

describe("client contract golden fixtures", () => {
  it("accepts all stable version 1 envelopes", () => {
    const fixtures = [
      decodeBootstrapResponse({
        bootstrapVersion: 1,
        instanceId: "daemon_1",
        dataIdentity: "data_1",
        clientApiVersions: [1],
        features: ["operations"],
        packageVersion: "0.0.0",
      }),
      decodeMutationEnvelope({
        mutationVersion: 1,
        requestId: "request_1",
        dataIdentity: "data_1",
        operation: "registerProject",
        target,
        arguments: { path: "/project" },
        preconditions: {},
      }),
      decodeOperationReceipt({
        receiptVersion: 1,
        requestId: "request_1",
        dataIdentity: "data_1",
        operation: "registerProject",
        status: "committed",
        result: { projectId: "project_1" },
      }),
      decodeOperationRefusal({
        refusalVersion: 1,
        requestId: "request_1",
        dataIdentity: "data_1",
        problem: {
          problemVersion: 1,
          code: "PROJECT_UNAVAILABLE",
          scope: target,
          retry: "safe",
          remedy: "Repair the Project.",
        },
      }),
      decodePaginationRequest({ paginationVersion: 1, limit: 50 }),
      decodePageMetadata({
        paginationVersion: 1,
        totalMatching: 1,
        snapshotVersion: 3,
        nextCursor: { cursorVersion: 1, value: "next_1" },
      }),
      decodeObservationSnapshot({
        observationVersion: 1,
        instanceId: "daemon_1",
        dataIdentity: "data_1",
        snapshotVersion: 3,
        observedAt: "2026-09-01T10:00:00Z",
        data: { projects: [] },
      }),
    ];

    expect(fixtures.every((fixture) => fixture.ok)).toBe(true);
  });

  it.each([
    [
      "changed field name",
      {
        mutationVersion: 1,
        requestID: "request_1",
        dataIdentity: "data_1",
        operation: "registerProject",
        target,
        arguments: {},
        preconditions: {},
      },
    ],
    [
      "missing version",
      {
        requestId: "request_1",
        dataIdentity: "data_1",
        operation: "registerProject",
        target,
        arguments: {},
        preconditions: {},
      },
    ],
    [
      "extra field",
      {
        mutationVersion: 1,
        requestId: "request_1",
        dataIdentity: "data_1",
        operation: "registerProject",
        target,
        arguments: {},
        preconditions: {},
        extra: true,
      },
    ],
    [
      "invalid number",
      {
        mutationVersion: 1,
        requestId: "request_1",
        dataIdentity: "data_1",
        operation: "registerProject",
        target,
        arguments: { count: Number.POSITIVE_INFINITY },
        preconditions: {},
      },
    ],
    [
      "invalid identity",
      {
        mutationVersion: 1,
        requestId: "",
        dataIdentity: "data_1",
        operation: "registerProject",
        target,
        arguments: {},
        preconditions: {},
      },
    ],
  ])("rejects %s", (_name, fixture) => {
    expect(decodeMutationEnvelope(fixture).ok).toBe(false);
  });
});
