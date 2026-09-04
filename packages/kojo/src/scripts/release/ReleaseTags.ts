import type { ReleaseStage } from "./ReleaseVersion.ts";

export interface ReleaseTagPlan {
  readonly remove: ReadonlyArray<string>;
  readonly removeLatestOnlyWhenItPointsTo: string | undefined;
  readonly set: Readonly<Record<string, string>>;
}

export const releaseTagPlan = (stage: ReleaseStage, version: string): ReleaseTagPlan => {
  if (stage === "stable") {
    return {
      remove: ["alpha", "beta", "rc", "candidate"],
      removeLatestOnlyWhenItPointsTo: undefined,
      set: { latest: version, next: version },
    };
  }

  return {
    remove: ["alpha", "beta", "rc", "candidate"].filter((tag) => tag !== stage),
    removeLatestOnlyWhenItPointsTo: version,
    set: { [stage]: version, next: version },
  };
};
