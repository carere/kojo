import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Acceptance, Judgement } from "../../../../../src/contexts/workflow/models/Acceptance.ts";

const suite = (accepted: boolean) =>
  new Judgement({ by: "the suite", accepted, reason: accepted ? "24 passed" : "3 failed" });

const engineer = (accepted: boolean) =>
  new Judgement({
    by: "kevin",
    accepted,
    reason: accepted ? "reads fine" : "this is not what I asked for",
  });

describe("acceptance as the conjunction of two judgements", () => {
  it("is the whole truth table, and only one row accepts", () => {
    const table = [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ] as const;

    for (const [mechanical, human, expected] of table) {
      const acceptance = new Acceptance({
        mechanical: suite(mechanical),
        human: engineer(human),
      });
      expect(acceptance.accepted).toBe(expected);
    }
  });

  /**
   * D7 in one assertion, and the row that is easy to get wrong.
   *
   * A test phase that ran a red suite did exactly its job — it passed. So a run whose every phase
   * succeeded and whose reviewer approved is still not accepted when the measurement says no.
   */
  it("refuses a run a human approved when the suite was red", () => {
    const acceptance = new Acceptance({ mechanical: suite(false), human: engineer(true) });
    expect(acceptance.accepted).toBe(false);
    expect(acceptance.refusal).toBe("the suite: 3 failed");
  });

  it("names both refusers when both refused, rather than the first one it found", () => {
    const acceptance = new Acceptance({ mechanical: suite(false), human: engineer(false) });
    expect(acceptance.refusal).toBe("the suite: 3 failed; kevin: this is not what I asked for");
  });

  it("says nothing when there is nothing to refuse", () => {
    expect(new Acceptance({ mechanical: suite(true), human: engineer(true) }).refusal).toBe("");
  });

  /**
   * It travels a workflow's success channel, so the engine has to be able to write it down and read
   * it back — and the round trip has to come back as the class, getters and all, rather than as a
   * struct that merely holds the same fields.
   */
  it("survives the round trip the engine persists it through", () => {
    const acceptance = new Acceptance({ mechanical: suite(true), human: engineer(false) });
    const encoded = Schema.encodeSync(Acceptance)(acceptance);
    const decoded = Schema.decodeUnknownSync(Acceptance)(JSON.parse(JSON.stringify(encoded)));

    expect(decoded).toBeInstanceOf(Acceptance);
    expect(decoded.accepted).toBe(false);
    expect(decoded.refusal).toBe("kevin: this is not what I asked for");
  });
});
