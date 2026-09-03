import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { Verdict } from "../../../../../src/contexts/gate/models/Verdict.ts";
import { Acceptance, Judgement } from "../../../../../src/contexts/workflow/models/Acceptance.ts";
import {
  fromVerdict,
  requireAcceptance,
} from "../../../../../src/contexts/workflow/services/acceptance.ts";

const answered = (choice: string) =>
  new Verdict({ choice, reason: "as I said at the gate", answerer: "kevin", answeredAt: 1000 });

const green = new Judgement({ by: "the suite", accepted: true, reason: "24 passed" });
const red = new Judgement({ by: "the suite", accepted: false, reason: "3 failed" });

describe("the human half of an acceptance", () => {
  it("accepts the one choice the reviewed loop calls approval", () => {
    expect(fromVerdict(answered("approve"))).toEqual(
      new Judgement({ by: "kevin", accepted: true, reason: "as I said at the gate" }),
    );
  });

  it("treats a rejection as a rejection", () => {
    expect(fromVerdict(answered("reject")).accepted).toBe(false);
  });

  /**
   * The safe reading of an answer nobody declared.
   *
   * A gate carries one shared `Verdict` so any adapter can answer any gate, which is exactly why
   * `choice` is a plain string and can hold a word this run never offered. Anything but the
   * approval is not an approval — the alternative is a run that lands because somebody typed
   * "approved" and the code was generous about it.
   */
  it("does not accept a word the gate never offered", () => {
    expect(fromVerdict(answered("approved")).accepted).toBe(false);
    expect(fromVerdict(answered("")).accepted).toBe(false);
    expect(fromVerdict(answered("APPROVE")).accepted).toBe(false);
  });

  it("attributes the judgement to whoever answered", () => {
    expect(fromVerdict(answered("approve")).by).toBe("kevin");
  });
});

describe("what the merge hangs on", () => {
  it.effect("passes the acceptance through when both halves said yes", () =>
    Effect.gen(function* () {
      const acceptance = new Acceptance({
        mechanical: green,
        human: fromVerdict(answered("approve")),
      });
      expect(yield* requireAcceptance(acceptance)).toBe(acceptance);
    }),
  );

  it.effect("fails with the refusers' own words when one half said no", () =>
    Effect.gen(function* () {
      const acceptance = new Acceptance({
        mechanical: red,
        human: fromVerdict(answered("approve")),
      });
      const outcome = yield* Effect.result(requireAcceptance(acceptance));

      expect(Result.isFailure(outcome)).toBe(true);
      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("NotAccepted");
      expect(Result.isFailure(outcome) && outcome.failure.reason).toBe("the suite: 3 failed");
    }),
  );
});
