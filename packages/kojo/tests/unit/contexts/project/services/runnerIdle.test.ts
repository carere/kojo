import { describe, expect, it } from "@effect/vitest";
import {
  runnerIsIdle,
  runnerShouldStop,
} from "../../../../../src/contexts/project/services/runnerIdle.ts";

describe("Project Runner idle boundary", () => {
  it("stops after 60 idle seconds while slot and human waits count as idle", () => {
    expect(runnerShouldStop({ demand: "none", idleSince: 0, now: 59_999 })).toBe(false);
    expect(runnerShouldStop({ demand: "none", idleSince: 0, now: 60_000 })).toBe(true);
    expect(runnerShouldStop({ demand: "waiting-for-slot", idleSince: 0, now: 60_000 })).toBe(true);
    expect(runnerShouldStop({ demand: "waiting-for-human", idleSince: 0, now: 60_000 })).toBe(true);
  });

  it("keeps execution, refresh, recovery, wake-up, and current Trigger polling busy", () => {
    for (const demand of [
      "execution",
      "trigger-polling",
      "refresh",
      "recovery",
      "ready-wakeup",
    ] as const) {
      expect(runnerIsIdle(demand)).toBe(false);
      expect(runnerShouldStop({ demand, idleSince: 0, now: 600_000 })).toBe(false);
    }
  });
});
