import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import {
  isObjectName,
  isSafeSegment,
  safeSegments,
} from "../../../../../src/contexts/trace/guards/identifiers.ts";

/**
 * The guard that stands between a URL and a path on disk.
 *
 * Every case here is a string somebody could put in a browser's address bar. The rule under test is
 * not "does it look wrong" but "is it one of the shapes we allow" — the guard is an allow list, and
 * a test written the other way round would pass while the list leaked.
 */
describe("one identifier as one path segment", () => {
  it("allows exactly letters, digits, dot, underscore and hyphen", () => {
    for (const value of ["run-1", "a4f0c9", "scout", "1", "phase_2", "v1.2.3", "-", "_"]) {
      expect(isSafeSegment(value)).toBe(true);
    }
  });

  it("refuses the two segments the pattern cannot refuse", () => {
    // Both match `^[A-Za-z0-9._-]+$`, and both are the traversal. They are named, not matched.
    expect(isSafeSegment(".")).toBe(false);
    expect(isSafeSegment("..")).toBe(false);
  });

  it("refuses separators, spaces, and everything else", () => {
    for (const value of [
      "",
      "a/b",
      "a\\b",
      "a b",
      "a%2fb",
      "a\0b",
      "a\nb",
      "étape",
      "a:b",
      "a*",
      "~",
    ]) {
      expect(isSafeSegment(value)).toBe(false);
    }
  });
});

describe("a multi-segment identifier", () => {
  it("splits a phase id into the segments it is made of", () => {
    // `makePhaseId` builds `<run>/<name>/<attempt>`, so a phase id is a path of identifiers rather
    // than one identifier — and the guard is applied to each part of it.
    expect(safeSegments("a4f0/scout/1")).toStrictEqual(Option.some(["a4f0", "scout", "1"]));
    expect(safeSegments("run-1")).toStrictEqual(Option.some(["run-1"]));
  });

  it("refuses an identifier where any one segment is not safe", () => {
    for (const value of [
      "",
      "..",
      "../etc/passwd",
      "a4f0/../../etc/passwd",
      "a4f0/./scout",
      "a4f0//scout",
      "/a4f0/scout",
      "a4f0/scout/",
      "..%2f..%2fetc",
      "....//",
      "C:\\Windows",
      "a4f0/sc out/1",
    ]) {
      expect(safeSegments(value)).toStrictEqual(Option.none());
    }
  });

  it("refuses rather than repairs, so nothing is handed back with the traversal removed", () => {
    // The failure mode this rule exists for: strip `..` from `....//` and `../` is what is left, and
    // the caller believes the value was checked. Refusing has no such second reading.
    const refused = safeSegments("....//");
    expect(Option.isNone(refused)).toBe(true);
  });
});

describe("a git object name", () => {
  it("allows hex of a length git could have produced", () => {
    expect(isObjectName("c0ffee")).toBe(true);
    expect(isObjectName("a".repeat(40))).toBe(true);
    expect(isObjectName("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  it("refuses anything git would read as a flag, and anything that is not hex", () => {
    // The reason this is stricter than a path segment: `-` is legal in a segment, so
    // `--upload-pack=…` is a "safe segment" and is also a git flag. `argv` is an array rather than a
    // shell here, so this is argument injection and not command injection — a smaller hole, and
    // still a hole. Hex has no flags in it.
    for (const value of [
      "--upload-pack=/bin/sh",
      "-n",
      "HEAD",
      "main",
      "c0ffee~1",
      "C0FFEE",
      "abc",
      "",
      "c0ffee zzz",
    ]) {
      expect(isObjectName(value)).toBe(false);
    }
  });
});
