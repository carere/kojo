import { describe, expect, it } from "vitest";
import { releaseTagPlan } from "../../../../src/scripts/release/ReleaseTags.ts";

describe("releaseTagPlan", () => {
  it("makes one prerelease stage active without changing an existing stable tag", () => {
    expect(releaseTagPlan("beta", "0.1.0-beta.2")).toEqual({
      remove: ["alpha", "rc", "candidate"],
      removeLatestOnlyWhenItPointsTo: "0.1.0-beta.2",
      set: { beta: "0.1.0-beta.2", next: "0.1.0-beta.2" },
    });
  });

  it("makes the validated stable version current and clears candidate tags", () => {
    expect(releaseTagPlan("stable", "0.1.0")).toEqual({
      remove: ["alpha", "beta", "rc", "candidate"],
      removeLatestOnlyWhenItPointsTo: undefined,
      set: { latest: "0.1.0", next: "0.1.0" },
    });
  });
});
