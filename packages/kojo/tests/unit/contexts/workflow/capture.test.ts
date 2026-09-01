import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Text,
} from "../../../../src/contexts/workflow/services/canonicalJson.ts";

describe("Workflow Revision identity", () => {
  it("uses sorted canonical objects, preserved arrays, and full SHA-256 identities", () => {
    const left = canonicalJson({ z: [2, 1], a: { y: true, x: "value" } });
    const right = canonicalJson({ a: { x: "value", y: true }, z: [2, 1] });

    expect(left).toBe(right);
    expect(left).toBe('{"a":{"x":"value","y":true},"z":[2,1]}');
    expect(sha256Text(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Text(left)).toBe(sha256Text(right));
    expect(canonicalJson({ z: [1, 2], a: { y: true, x: "value" } })).not.toBe(left);
  });

  it("refuses non-finite identity input", () => {
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow("finite numbers");
  });
});
