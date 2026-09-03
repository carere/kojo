import { describe, expect, it } from "vitest";
import {
  assertShippedCompletedRunEvidence,
  assertShippedWaitingGateEvidence,
} from "../../../support/release/ShippedMacosEvidence.ts";

describe("shipped macOS Gate lifecycle evidence", () => {
  it("accepts an unanswered Asking before the settled Gate Trace exists", () => {
    const runId = "run-release-evidence";
    const run = {
      runId,
      state: "suspended",
      phases: [{}],
      artifacts: [{}],
      gates: [],
      sandboxes: [{ outcome: "interrupted" }],
    };
    const snapshot = {
      askings: [
        {
          token: "gate-token",
          identity: { runId },
          state: "unanswered",
          description: "Approve the controlled shipped macOS Run",
        },
      ],
    };

    expect(() => assertShippedWaitingGateEvidence(run, snapshot)).not.toThrow();
  });

  it("rejects a suspended Run without its unanswered Asking", () => {
    expect(() =>
      assertShippedWaitingGateEvidence(
        {
          runId: "run-release-evidence",
          state: "suspended",
          phases: [{}],
          artifacts: [{}],
          gates: [],
          sandboxes: [{ outcome: "interrupted" }],
        },
        { askings: [] },
      ),
    ).toThrow("the pre-Verdict Run and Asking evidence is incomplete");
  });

  it("rejects a settled Gate Trace before the Verdict", () => {
    const runId = "run-release-evidence";
    expect(() =>
      assertShippedWaitingGateEvidence(
        {
          runId,
          state: "suspended",
          phases: [{}],
          artifacts: [{}],
          gates: [{ outcome: "answered" }],
          sandboxes: [{ outcome: "interrupted" }],
        },
        {
          askings: [
            {
              token: "gate-token",
              identity: { runId },
              state: "unanswered",
              description: "Approve the controlled shipped macOS Run",
            },
          ],
        },
      ),
    ).toThrow("the pre-Verdict Run and Asking evidence is incomplete");
  });

  it("requires the settled Gate Trace and every final record after application", () => {
    const completed = {
      runId: "run-release-evidence",
      state: "succeeded",
      phases: [{}, {}],
      artifacts: [{}],
      gates: [{ outcome: "answered" }],
      sandboxes: [{ outcome: "interrupted" }, { outcome: "released" }],
    };

    expect(() => assertShippedCompletedRunEvidence(completed)).not.toThrow();
    expect(() => assertShippedCompletedRunEvidence({ ...completed, gates: [] })).toThrow(
      "the settled real Run evidence is incomplete",
    );
    expect(() =>
      assertShippedCompletedRunEvidence({
        ...completed,
        gates: [{ outcome: "answered" }, { outcome: "answered" }],
      }),
    ).toThrow("the settled real Run evidence is incomplete");
  });
});
