import { describe, expect, it } from "vitest";
import { shippedRunEvidence } from "../../../support/release/ShippedRunEvidence.ts";

const uncertainty = {
  actionId: "action_1d89f20c7fa864fa7bec57e41b46e3a8",
  revisionId: "efe5e85d817db248569f86c9267569b80d5893c6f0562081ae4bb41d08cc7101",
  phasePath: "confirm-verdict",
  attempt: 1,
  inputHash: "959b61338958b8ea79d02488e2b24e777ec74f29a6fa22b20f1d037c051c4b56",
  recoveryPolicy: "unresolved",
  state: "result-confirmed",
  uncertaintyRevision: 0,
  evidence: {
    kind: "original-result",
    detail: "The current fenced Project Runner returned the encoded original-contract result.",
    observedAt: "2026-09-02T03:24:21.955Z",
  },
};

const output = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    run: {
      state: "succeeded",
      phases: [{ phasePath: "publish-evidence" }, { phasePath: "confirm-verdict" }],
      gates: [{ outcome: "answered" }],
      sandboxes: [{ outcome: "released" }, { outcome: "released" }],
      artifacts: [{ name: "shipped-linux.txt" }],
      uncertainty,
      ...overrides,
    },
  });

describe("shipped Linux terminal Run evidence", () => {
  it("accepts the sixth-run terminal result-confirmed uncertainty", () => {
    expect(shippedRunEvidence(output())).toEqual({
      valid: true,
      diagnostic: "terminal Run uncertainty is result-confirmed with original-result evidence",
      uncertainty: "result-confirmed",
    });
  });

  it("rejects unresolved uncertainty", () => {
    expect(
      shippedRunEvidence(output({ uncertainty: { ...uncertainty, state: "unresolved" } })),
    ).toMatchObject({
      valid: false,
      diagnostic: "terminal Run uncertainty is unresolved",
    });
  });

  it("keeps unrelated optional terminal fields absent", () => {
    expect(shippedRunEvidence(output({ cleanup: null }))).toMatchObject({
      valid: false,
      diagnostic: "terminal Run retains optional field cleanup",
    });
  });
});
