import { describe, expect, it } from "@effect/vitest";
import {
  decodeLifecycleControlRequest,
  decodeLifecycleOwner,
} from "../../../../../src/contexts/daemon/services/LifecycleControlProtocol.ts";

describe("Lifecycle control protocol", () => {
  it("rejects malformed action fields before a cleanup command reaches its port", () => {
    expect(() =>
      decodeLifecycleControlRequest({
        formatVersion: 1,
        operationId: "operation-1",
        controlSecret: "a".repeat(64),
        action: "stop-owned-processes",
        cleanupMillis: "30000",
        replacementExpected: false,
      }),
    ).toThrow(/cleanup requires/);
    expect(() =>
      decodeLifecycleControlRequest({
        formatVersion: 1,
        operationId: "operation-1",
        controlSecret: "a".repeat(64),
        action: "read-drain",
        dataIdentity: "not-valid-for-this-action",
      }),
    ).toThrow(/different action/);
  });

  it("rejects invalid owner bytes before the client trusts a replacement", () => {
    expect(() =>
      decodeLifecycleOwner({
        daemonInstanceId: "not a valid instance",
        runnerInstanceIds: [],
        recordedAt: "2026-09-01T10:00:00.000Z",
      }),
    ).toThrow(/owner response is invalid/);
  });
});
