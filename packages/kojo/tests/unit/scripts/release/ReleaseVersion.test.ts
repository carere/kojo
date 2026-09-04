import { describe, expect, it } from "vitest";
import {
  assertPrereleaseFollowsCandidate,
  assertReleaseStage,
  assertStableFollowsCandidate,
  parseReleaseVersion,
} from "../../../../src/scripts/release/ReleaseVersion.ts";

describe("ReleaseVersion", () => {
  it.each([
    ["0.1.0-alpha.1", "alpha", "0.1.0", 1],
    ["0.1.0-beta.12", "beta", "0.1.0", 12],
    ["0.1.0-rc.2", "rc", "0.1.0", 2],
    ["0.1.0", "stable", "0.1.0", undefined],
  ] as const)("parses %s", (version, stage, baseVersion, sequence) => {
    expect(parseReleaseVersion(version)).toEqual({ baseVersion, sequence, stage, version });
  });

  it.each(["0.0.0", "0.1", "0.1.0-preview.1", "0.1.0-alpha.0", "01.1.0"])(
    "refuses invalid release version %s",
    (version) => {
      expect(() => parseReleaseVersion(version)).toThrow("Invalid release version");
    },
  );

  it("refuses a version that does not match the requested stage", () => {
    expect(() => assertReleaseStage("0.1.0-beta.1", "alpha")).toThrow("requires alpha");
  });

  it("accepts a stable version from the same release candidate line", () => {
    expect(() => assertStableFollowsCandidate("0.1.0", "0.1.0-rc.3")).not.toThrow();
  });

  it("refuses a stable version from another release candidate line", () => {
    expect(() => assertStableFollowsCandidate("0.2.0", "0.1.0-rc.3")).toThrow("does not belong");
  });

  it.each([
    ["0.1.0-alpha.1", undefined],
    ["0.1.0-alpha.2", undefined],
    ["0.1.0-alpha.2", "0.1.0-alpha.1"],
    ["0.1.0-beta.1", "0.1.0-alpha.3"],
    ["0.1.0-beta.2", "0.1.0-beta.1"],
    ["0.1.0-rc.1", "0.1.0-beta.2"],
    ["0.1.0-rc.2", "0.1.0-rc.1"],
  ] as const)("accepts %s after %s", (version, previous) => {
    expect(() => assertPrereleaseFollowsCandidate(version, previous)).not.toThrow();
  });

  it.each([
    ["0.1.0-beta.2", undefined],
    ["0.1.0-beta.1", "0.1.0-beta.2"],
    ["0.1.0-rc.1", "0.1.0-alpha.3"],
    ["0.2.0-rc.1", "0.1.0-beta.2"],
  ] as const)("refuses %s after %s", (version, previous) => {
    expect(() => assertPrereleaseFollowsCandidate(version, previous)).toThrow();
  });
});
