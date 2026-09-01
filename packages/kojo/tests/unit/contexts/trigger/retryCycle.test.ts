import { describe, expect, it } from "@effect/vitest";
import {
  TRIGGER_RETRY_DELAYS_MILLIS,
  triggerRetryDelay,
} from "../../../../src/contexts/trigger/services/retryCycle.ts";

describe("Trigger transient fault cycle", () => {
  it("uses one bounded five-delay cycle and resets after source progress", () => {
    expect(TRIGGER_RETRY_DELAYS_MILLIS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(triggerRetryDelay(1)).toBe(1_000);
    expect(triggerRetryDelay(5)).toBe(16_000);
    expect(triggerRetryDelay(6)).toBeUndefined();
    expect(triggerRetryDelay(0)).toBeUndefined();
  });
});
