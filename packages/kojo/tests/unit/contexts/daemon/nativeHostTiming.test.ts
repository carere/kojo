import { describe, expect, it } from "vitest";
import {
  NATIVE_HOST_TEST_TIMEOUT_MILLIS,
  NATIVE_HOST_TRANSITION_TIMEOUT_MILLIS,
} from "../../../support/daemon/nativeHostTiming.ts";

describe("native Host evidence timing", () => {
  it("keeps each transition at sixty seconds and gives the multi-restart scenario three bounds", () => {
    expect(NATIVE_HOST_TRANSITION_TIMEOUT_MILLIS).toBe(60_000);
    expect(NATIVE_HOST_TEST_TIMEOUT_MILLIS).toBe(NATIVE_HOST_TRANSITION_TIMEOUT_MILLIS * 3);
  });
});
