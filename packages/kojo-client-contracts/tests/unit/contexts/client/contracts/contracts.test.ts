import { describe, expect, it } from "vitest";
import { decodeBootstrapResponse } from "../../../../../src/contexts/client/contracts/bootstrap.ts";
import { decodeMutationEnvelope } from "../../../../../src/contexts/client/contracts/mutation.ts";
import {
  decodeOperationReceipt,
  decodeOperationRefusal,
  decodeRecordedOperationOutcome,
} from "../../../../../src/contexts/client/contracts/operation.ts";

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
      decodeRecordedOperationOutcome({
        receiptVersion: 1,
        requestId: "request_1",
        dataIdentity: "data_1",
        operation: "registerProject",
        status: "committed",
        resultReference: {
          identityVersion: 1,
          kind: "operationOutcome",
          parts: ["request_1"],
        },
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
