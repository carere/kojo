import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedDaemonSupervision } from "../../../../src/contexts/daemon/adapters/ManagedDaemonSupervision.ts";

const fixture = () => {
  let time = Date.parse("2026-09-01T10:00:00.000Z");
  const dataRoot = mkdtempSync(join(tmpdir(), "kojo-daemon-supervision-"));
  const repository = () => new ManagedDaemonSupervision(dataRoot, { now: () => time });
  const advance = (milliseconds: number): void => {
    time += milliseconds;
  };
  const start = (supervision = repository()) => {
    const prepared = supervision.prepareAttempt();
    if (prepared.outcome !== "scheduled") throw new Error("the Daemon attempt was not scheduled");
    advance(prepared.delayMs);
    supervision.startAttempt(prepared.attemptId);
    return { supervision, attemptId: prepared.attemptId, delayMs: prepared.delayMs };
  };
  return { advance, dataRoot, repository, start };
};

describe("managed Daemon supervision", () => {
  it("does not consume a budget for a planned replacement, including launcher replacement", () => {
    const test = fixture();
    const first = test.start();
    first.supervision.recordReady(first.attemptId);
    first.supervision.recordPlannedStop(first.attemptId);

    const replacement = test.repository().prepareAttempt();
    expect(replacement).toMatchObject({ outcome: "scheduled", delayMs: 0 });
    expect(test.repository().status()).toMatchObject({
      repairRequired: false,
      nextRestartIndex: 0,
      restartAttemptsRemaining: 5,
    });
  });

  it("finishes a planned stop during delay so a later crash consumes the current budget", () => {
    const test = fixture();
    const initial = test.start();
    initial.supervision.finishAttempt(initial.attemptId, { detail: "initial fault" });
    const waiting = test.repository().prepareAttempt();
    if (waiting.outcome !== "scheduled") throw new Error("the retry was not scheduled");
    expect(waiting.delayMs).toBe(1_000);
    test.repository().finishAttempt(waiting.attemptId, {
      planned: true,
      detail: "the native manager stopped the scheduled retry",
    });

    const replacement = test.start();
    expect(replacement.delayMs).toBe(0);
    replacement.supervision.finishAttempt(replacement.attemptId, {
      detail: "replacement infrastructure fault",
    });
    expect(test.start().delayMs).toBe(1_000);
  });

  it("persists five failed automatic attempts and exhaustion across launcher replacement", () => {
    const test = fixture();
    const initial = test.start();
    initial.supervision.finishAttempt(initial.attemptId, {
      detail: "initial infrastructure fault",
    });

    for (const expectedDelay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      const attempt = test.start(test.repository());
      expect(attempt.delayMs).toBe(expectedDelay);
      attempt.supervision.finishAttempt(attempt.attemptId, {
        detail: `automatic attempt after ${expectedDelay}`,
      });
    }

    expect(test.repository().status()).toMatchObject({
      state: "exhausted",
      repairRequired: true,
      nextRestartIndex: 5,
      restartAttemptsRemaining: 0,
      lastFailure: { detail: "automatic attempt after 16000" },
    });
    expect(test.repository().prepareAttempt().outcome).toBe("exhausted");
  });

  it("resets only after readiness and an operation succeed, never from process lifetime or heartbeat", () => {
    const test = fixture();
    const initial = test.start();
    initial.supervision.finishAttempt(initial.attemptId, { detail: "initial fault" });

    const neverReady = test.start();
    expect(neverReady.delayMs).toBe(1_000);
    test.advance(300_000);
    neverReady.supervision.finishAttempt(neverReady.attemptId, { detail: "never became ready" });
    const second = test.start();
    expect(second.delayMs).toBe(2_000);
    second.supervision.recordReady(second.attemptId);
    test.advance(300_000);
    second.supervision.finishAttempt(second.attemptId, {
      detail: "heartbeat-only process failed after the healthy period",
    });
    const third = test.start();
    expect(third.delayMs).toBe(4_000);
    third.supervision.recordReady(third.attemptId);
    third.supervision.recordOperationSuccess(third.attemptId);
    test.advance(300_000);
    third.supervision.finishAttempt(third.attemptId, {
      detail: "failed after readiness and a successful operation",
    });

    expect(test.start().delayMs).toBe(1_000);
  });

  it("applies activated policy only to future attempts", () => {
    const test = fixture();
    const initial = test.start();
    initial.supervision.activatePolicy(initial.attemptId, {
      restartDelaysMs: [7, 11],
      healthyResetMs: 50,
    });
    initial.supervision.finishAttempt(initial.attemptId, { detail: "fault after activation" });

    const later = test.start();
    expect(later.delayMs).toBe(7);
    expect(later.supervision.status().policy).toEqual({
      restartDelaysMs: [7, 11],
      healthyResetMs: 50,
    });
  });

  it("requires one exact unexpired current plan to repair an exhausted budget", () => {
    const test = fixture();
    const initial = test.start();
    initial.supervision.activatePolicy(initial.attemptId, {
      restartDelaysMs: [1],
      healthyResetMs: 10,
    });
    initial.supervision.finishAttempt(initial.attemptId, { detail: "initial fault" });
    const automatic = test.start();
    automatic.supervision.finishAttempt(automatic.attemptId, { detail: "budget exhausted" });

    const firstPlan = test.repository().checkRepair().repairPlan;
    if (firstPlan === undefined) throw new Error("the repair plan was not issued");
    const replacementPlan = test.repository().checkRepair().repairPlan;
    if (replacementPlan === undefined)
      throw new Error("the replacement repair plan was not issued");
    expect(() => test.repository().applyRepair(firstPlan.planId)).toThrow(
      "the exact unexpired Daemon supervision repair plan is not current",
    );
    test.advance(600_001);
    expect(() => test.repository().applyRepair(replacementPlan.planId)).toThrow(
      "the exact unexpired Daemon supervision repair plan is not current",
    );

    const currentPlan = test.repository().checkRepair().repairPlan;
    if (currentPlan === undefined) throw new Error("the current repair plan was not issued");
    expect(test.repository().applyRepair(currentPlan.planId)).toMatchObject({
      state: "idle",
      repairRequired: false,
      nextRestartIndex: 0,
      restartAttemptsRemaining: 1,
      lastFailure: { detail: "budget exhausted" },
      lastRepair: { planId: currentPlan.planId },
    });
    const restarted = test.start(test.repository());
    expect(restarted.delayMs).toBe(0);
    expect(test.repository().applyRepair(currentPlan.planId)).toMatchObject({
      state: "running",
      lastRepair: { planId: currentPlan.planId },
    });
  });

  it("rejects unknown stored fields and inconsistent retained state", () => {
    const test = fixture();
    test.repository().prepareAttempt();
    const repository = test.repository();
    const statePath = join(test.dataRoot, "launcher-supervision", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    state.escapeHatch = true;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    expect(() => repository.status()).toThrow("the launcher state is invalid");
  });
});
