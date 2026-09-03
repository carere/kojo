import { describe, expect, it } from "vitest";
import { collectShippedMacosEvidence } from "../support/release/ShippedMacosEvidence.ts";

describe("the shipped macOS installation", () => {
  it("follows the printed install and Factory path through native lifecycle and real browser evidence", async () => {
    expect(process.env.KOJO_SHIPPED_MACOS_EVIDENCE).toBe("1");
    await collectShippedMacosEvidence();
  });
});
