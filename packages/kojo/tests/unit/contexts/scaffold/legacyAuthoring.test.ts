import {
  Acceptance as LegacyAcceptance,
  Judgement as LegacyJudgement,
} from "@carere/kojo/contexts/workflow/models/Acceptance";
import {
  Acceptance as RuntimeAcceptance,
  Judgement as RuntimeJudgement,
} from "@carere/kojo-runtime/contexts/workflow/models/Acceptance";
import { describe, expect, it } from "vitest";

describe("the authoring compatibility window", () => {
  it("keeps legacy and Project-runtime deep imports usable", () => {
    const legacy = new LegacyAcceptance({
      mechanical: new LegacyJudgement({ by: "suite", accepted: true, reason: "green" }),
      human: new LegacyJudgement({ by: "reviewer", accepted: true, reason: "approved" }),
    });
    const runtime = new RuntimeAcceptance({
      mechanical: new RuntimeJudgement({ by: "suite", accepted: true, reason: "green" }),
      human: new RuntimeJudgement({ by: "reviewer", accepted: true, reason: "approved" }),
    });

    expect(legacy.accepted).toBe(true);
    expect(runtime.accepted).toBe(true);
  });
});
