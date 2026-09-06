import {
  assertPrereleaseFollowsCandidate,
  assertStableFollowsCandidate,
  parseReleaseVersion,
} from "./ReleaseVersion.ts";

export const requiresFullEvidence = (version: string): boolean =>
  parseReleaseVersion(version).stage !== "alpha";

// Only accepted GitHub Releases may be supplied here. Registry tags are mutable and are not
// acceptance records. A newer stage must never silently fall back to an older stage.
export const selectPredecessor = (
  version: string,
  acceptedVersions: ReadonlyArray<string>,
): string | undefined => {
  const release = parseReleaseVersion(version);
  const candidates = acceptedVersions
    .filter((candidate) => {
      try {
        const previous = parseReleaseVersion(candidate);
        return previous.baseVersion === release.baseVersion && previous.stage !== "stable";
      } catch {
        return false;
      }
    })
    .sort((left, right) => Bun.semver.order(right, left));
  const previous = candidates[0];
  if (release.stage === "stable") {
    if (previous === undefined) throw new Error(`${version} requires an accepted RC.`);
    assertStableFollowsCandidate(version, previous);
  } else {
    assertPrereleaseFollowsCandidate(version, previous);
  }
  return previous;
};
