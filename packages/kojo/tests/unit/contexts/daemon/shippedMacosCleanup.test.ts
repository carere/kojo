import { describe, expect, it } from "vitest";
import { DAEMON_CLEANUP_MILLIS } from "../../../../src/contexts/daemon/services/LifecycleController.ts";
import {
  SHIPPED_MACOS_REMOVAL_TIMEOUT_MILLIS,
  shippedMacosRemovalArguments,
} from "../../../support/release/ShippedMacosEvidence.ts";

describe("shipped macOS managed cleanup", () => {
  it("allows one internal cleanup interval before sealing and removal", () => {
    expect(SHIPPED_MACOS_REMOVAL_TIMEOUT_MILLIS).toBe(60_000);
    expect(SHIPPED_MACOS_REMOVAL_TIMEOUT_MILLIS).toBeGreaterThan(DAEMON_CLEANUP_MILLIS);
    expect(shippedMacosRemovalArguments("/managed/kojo")).toEqual([
      "/managed/kojo",
      "daemon",
      "remove",
      "--timeout",
      "60000ms",
    ]);
  });
});
