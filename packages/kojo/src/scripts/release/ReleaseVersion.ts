export const releaseStages = ["alpha", "beta", "rc", "stable"] as const;

export type ReleaseStage = (typeof releaseStages)[number];

export interface ReleaseVersion {
  readonly baseVersion: string;
  readonly sequence: number | undefined;
  readonly stage: ReleaseStage;
  readonly version: string;
}

const numericIdentifier = "(?:0|[1-9]\\d*)";
const stablePattern = new RegExp(
  `^(${numericIdentifier})\\.(${numericIdentifier})\\.(${numericIdentifier})$`,
);
const prereleasePattern = new RegExp(
  `^(${numericIdentifier})\\.(${numericIdentifier})\\.(${numericIdentifier})-(alpha|beta|rc)\\.([1-9]\\d*)$`,
);

export const parseReleaseVersion = (version: string): ReleaseVersion => {
  const prerelease = prereleasePattern.exec(version);
  if (prerelease !== null) {
    const [, major, minor, patch, stage, sequence] = prerelease;
    return {
      baseVersion: `${major}.${minor}.${patch}`,
      sequence: Number(sequence),
      stage: stage as Exclude<ReleaseStage, "stable">,
      version,
    };
  }

  const stable = stablePattern.exec(version);
  if (stable !== null && version !== "0.0.0") {
    return {
      baseVersion: version,
      sequence: undefined,
      stage: "stable",
      version,
    };
  }

  throw new Error(
    `Invalid release version '${version}'. Use X.Y.Z-(alpha|beta|rc).N or a non-zero X.Y.Z stable version.`,
  );
};

export const assertReleaseStage = (
  version: string,
  expectedStage: ReleaseStage,
): ReleaseVersion => {
  const release = parseReleaseVersion(version);
  if (release.stage !== expectedStage) {
    throw new Error(
      `Release version '${version}' is ${release.stage}, but this operation requires ${expectedStage}.`,
    );
  }
  return release;
};

export const assertStableFollowsCandidate = (
  stableVersion: string,
  releaseCandidateVersion: string,
): void => {
  const stable = assertReleaseStage(stableVersion, "stable");
  const releaseCandidate = assertReleaseStage(releaseCandidateVersion, "rc");
  if (stable.baseVersion !== releaseCandidate.baseVersion) {
    throw new Error(
      `Stable version '${stableVersion}' does not belong to release candidate '${releaseCandidateVersion}'.`,
    );
  }
};

export const assertPrereleaseFollowsCandidate = (
  version: string,
  previousCandidateVersion?: string,
): void => {
  const release = parseReleaseVersion(version);
  if (release.stage === "stable") {
    throw new Error(`Release version '${version}' is not a prerelease.`);
  }

  if (previousCandidateVersion === undefined || previousCandidateVersion.length === 0) {
    if (release.stage === "alpha") return;
    throw new Error(`${version} requires the previous accepted candidate.`);
  }

  const previous = parseReleaseVersion(previousCandidateVersion);
  if (previous.stage === "stable" || previous.baseVersion !== release.baseVersion) {
    throw new Error(`${previousCandidateVersion} cannot precede ${version}.`);
  }

  const valid =
    (release.stage === "alpha" &&
      previous.stage === "alpha" &&
      (previous.sequence ?? 0) < (release.sequence ?? 0)) ||
    (release.stage === "beta" && previous.stage === "alpha") ||
    (release.stage === "beta" &&
      previous.stage === "beta" &&
      (previous.sequence ?? 0) < (release.sequence ?? 0)) ||
    (release.stage === "rc" && previous.stage === "beta") ||
    (release.stage === "rc" &&
      previous.stage === "rc" &&
      (previous.sequence ?? 0) < (release.sequence ?? 0));

  if (!valid) throw new Error(`${previousCandidateVersion} cannot precede ${version}.`);
};
