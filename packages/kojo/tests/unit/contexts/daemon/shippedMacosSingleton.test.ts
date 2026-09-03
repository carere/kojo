import { describe, expect, it } from "vitest";
import { assertShippedSingletonEvidence } from "../../../support/release/ShippedMacosEvidence.ts";

const rejectedDuplicate = {
  exitCode: 1,
  stdout: "",
  stderr:
    'error: another Daemon start or purge transition owns the stable lifecycle gate\ncode: "PURGE_GATE_HELD"\n',
};

describe("shipped macOS singleton evidence", () => {
  it("accepts the exact duplicate Daemon refusal without owner replacement", () => {
    expect(() =>
      assertShippedSingletonEvidence(rejectedDuplicate, "active-instance", "active-instance"),
    ).not.toThrow();
  });

  it("rejects a wrong outcome, refusal reason, or active owner", () => {
    expect(() =>
      assertShippedSingletonEvidence(
        { ...rejectedDuplicate, exitCode: 0 },
        "active-instance",
        "active-instance",
      ),
    ).toThrow("a duplicate shipped Daemon did not preserve the active Daemon owner");
    expect(() =>
      assertShippedSingletonEvidence(
        { ...rejectedDuplicate, stderr: 'code: "PURGE_GATE_HELD"\nunrelated failure\n' },
        "active-instance",
        "active-instance",
      ),
    ).toThrow("a duplicate shipped Daemon did not preserve the active Daemon owner");
    expect(() =>
      assertShippedSingletonEvidence(
        {
          ...rejectedDuplicate,
          stderr:
            "error: another Daemon start or purge transition owns the stable lifecycle gate\n",
        },
        "active-instance",
        "active-instance",
      ),
    ).toThrow("a duplicate shipped Daemon did not preserve the active Daemon owner");
    expect(() =>
      assertShippedSingletonEvidence(rejectedDuplicate, "active-instance", "replacement-instance"),
    ).toThrow("a duplicate shipped Daemon did not preserve the active Daemon owner");
  });
});
