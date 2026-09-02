import { describe, it } from "vitest";
import { collectShippedMacosEvidence } from "../support/release/ShippedMacosEvidence.ts";

const requested = process.env.KOJO_SHIPPED_MACOS_EVIDENCE === "1";

describe.skipIf(!requested)("the shipped macOS installation", () => {
  it("follows the printed install and Factory path through native lifecycle and real browser evidence", async () => {
    await collectShippedMacosEvidence();
  });
});
