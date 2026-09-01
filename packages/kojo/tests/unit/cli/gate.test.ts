import type {
  AskingDocument,
  AskingSnapshot,
} from "@carere/kojo-client-contracts/contexts/client/contracts/gate";
import { Runtime } from "effect";
import { describe, expect, it } from "vitest";
import { ClientExit } from "../../../src/cli/ClientExit.ts";
import {
  askingLine,
  gateWaitExit,
  validateGateAnswerFlags,
  visibleAskings,
} from "../../../src/cli/gate.ts";

const asking = (
  state: AskingDocument["state"],
  terminalInability?: AskingDocument["terminalInability"],
): AskingDocument => ({
  identity: {
    identityVersion: 1,
    runId: `run-${state}`,
    gatePath: "release/approval",
    askingNumber: 1,
    escalationStage: 0,
  },
  token: `token-${state}`,
  projectId: "project-one",
  workflowName: "release",
  description: "Ship this release?",
  actor: "release-manager",
  choices: ["approve", "reject", "revise"],
  createdAt: "2026-09-01T10:00:00.000Z",
  deadline: "2026-09-01T12:00:00.000Z",
  expiryBranch: "fail",
  state,
  ...(state === "unanswered"
    ? {}
    : {
        verdict: {
          choice: "approve",
          reason: "ready",
          answerer: "operator",
          recordedAt: "2026-09-01T11:00:00.000Z",
        },
      }),
  ...(state === "applied" ? { appliedAt: "2026-09-01T11:00:01.000Z" } : {}),
  ...(terminalInability === undefined ? {} : { terminalInability }),
});

const snapshot = (askings: ReadonlyArray<AskingDocument>): AskingSnapshot => ({
  observationVersion: 1,
  instanceId: "instance",
  dataIdentity: "data",
  snapshotVersion: 1,
  observedAt: "2026-09-01T11:00:00.000Z",
  refreshAfterMillis: 1_000,
  askings,
  counts: { total: askings.length, unanswered: 1, recorded: 1, applied: 1, expired: 1 },
});

describe("Gate CLI contract", () => {
  it("lists Unanswered and Recorded by default and every state with --all", () => {
    const askings = [
      asking("unanswered"),
      asking("recorded"),
      asking("applied"),
      { ...asking("unanswered"), state: "expired" as const, expiredAt: "2026-09-01T12:00:00.000Z" },
    ];
    expect(visibleAskings(snapshot(askings), false).map(({ state }) => state)).toEqual([
      "unanswered",
      "recorded",
    ]);
    expect(visibleAskings(snapshot(askings), true)).toEqual(askings);
    expect(askingLine(askings[0] as AskingDocument)).toContain("Token=token-unanswered");
    expect(askingLine(askings[0] as AskingDocument)).toContain("Choices=approve,reject,revise");
  });

  it("accepts a wait timeout and refuses a timeout without --wait as usage exit 2", () => {
    expect(validateGateAnswerFlags({ wait: false })).toBeUndefined();
    expect(validateGateAnswerFlags({ wait: true })).toBe(60_000);
    expect(validateGateAnswerFlags({ wait: true, timeout: "250ms" })).toBe(250);
    expect(() => validateGateAnswerFlags({ wait: false, timeout: "1s" })).toThrow(
      "only with --wait",
    );
    const usage = new ClientExit({ code: 2, message: "invalid arguments" });
    expect(usage[Runtime.errorExitCode]).toBe(2);
  });

  it("waits through Recorded, succeeds only on Applied, and fails on terminal inability", () => {
    expect(gateWaitExit(asking("recorded"))).toBeUndefined();
    expect(gateWaitExit(asking("applied"))).toBe(0);
    expect(gateWaitExit(asking("recorded", "run-failed"))).toBe(1);
    expect(gateWaitExit(asking("recorded", "run-cancelled"))).toBe(1);
    expect(new ClientExit({ code: 3, message: "timeout" })[Runtime.errorExitCode]).toBe(3);
    expect(new ClientExit({ code: 130, message: "interrupted" })[Runtime.errorExitCode]).toBe(130);
  });
});
