import { describe, expect, it } from "vitest";
import { createGateToken } from "../../../../../src/contexts/gate/services/createGateToken.ts";

describe("Gate token creation", () => {
  it("keeps the 256-bit capability safe as a positional CLI argument", () => {
    expect(createGateToken()).toMatch(/^gate_[A-Za-z0-9_-]{43}$/);
  });
});
