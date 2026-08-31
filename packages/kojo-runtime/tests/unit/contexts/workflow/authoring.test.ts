import { Acceptance, Judgement } from "@carere/kojo-runtime/contexts/workflow/models/Acceptance";
import { describe, expect, it } from "vitest";

describe("runtime authoring compatibility", () => {
  it("keeps the accepted judgement behavior", () => {
    const acceptance = new Acceptance({
      mechanical: new Judgement({ by: "suite", accepted: true, reason: "green" }),
      human: new Judgement({ by: "reviewer", accepted: false, reason: "needs work" }),
    });

    expect(acceptance.accepted).toBe(false);
    expect(acceptance.refusal).toBe("reviewer: needs work");
  });
});
