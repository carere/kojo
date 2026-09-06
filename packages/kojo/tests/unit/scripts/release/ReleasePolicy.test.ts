import { describe, expect, it } from "vitest";
import {
  requiresFullEvidence,
  selectPredecessor,
} from "../../../../src/scripts/release/ReleasePolicy.ts";

describe("Release evidence and stage selection", () => {
  it.each([
    ["0.1.0-alpha.1", false],
    ["0.1.0-beta.1", true],
    ["0.1.0-rc.1", true],
    ["0.1.0", true],
  ])("requires full Host evidence for %s: %s", (version, full) => {
    expect(requiresFullEvidence(version)).toBe(full);
  });
  it("starts an alpha without a previous accepted Release", () => {
    expect(selectPredecessor("0.1.0-alpha.1", ["junk", "0.0.9-rc.1"])).toBeUndefined();
  });
  it("uses numeric sequence order within the same Release line", () => {
    expect(
      selectPredecessor("0.1.0-beta.1", ["0.1.0-alpha.2", "0.1.0-alpha.10", "0.2.0-rc.1"]),
    ).toBe("0.1.0-alpha.10");
  });
  it.each(["0.1.0-beta.1", "0.1.0-rc.1", "0.1.0"])(
    "refuses %s without its predecessor",
    (version) => {
      expect(() => selectPredecessor(version, [])).toThrow();
    },
  );
  it("does not fall back to an old stage after a beta was accepted", () => {
    expect(() => selectPredecessor("0.1.0-alpha.2", ["0.1.0-alpha.1", "0.1.0-beta.1"])).toThrow();
  });
  it("selects the last accepted RC for stable", () => {
    expect(selectPredecessor("0.1.0", ["0.1.0-beta.1", "0.1.0-rc.2", "0.1.0-rc.1"])).toBe(
      "0.1.0-rc.2",
    );
  });
});
