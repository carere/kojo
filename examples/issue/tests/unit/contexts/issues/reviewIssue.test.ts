import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { reviewIssue } from "../../../../.kojo/issues/reviewIssue.ts";

describe("the authored issue review", () => {
  it.effect(
    "returns failed review findings for repair and commits only after both checks pass",
    () =>
      Effect.gen(function* () {
        const actions: Array<string> = [];
        const reasons: Array<string> = [];
        const result = yield* reviewIssue({
          issue: 1,
          branch: "selected-pr",
          repairs: 2,
          delivery: {
            implement: (round, reason) =>
              Effect.sync(() => {
                actions.push(`implement-${round}`);
                reasons.push(reason);
              }),
            check: (round) =>
              Effect.sync(() => {
                actions.push(`check-${round}`);
                return { passed: round > 0, details: "type error" };
              }),
            review: (round) =>
              Effect.sync(() => {
                actions.push(`review-${round}`);
                return { passed: round > 1, details: "button cannot be reached with the keyboard" };
              }),
            commit: () =>
              Effect.sync(() => {
                actions.push("commit");
                return "accepted-sha";
              }),
          },
        });
        expect(actions).toEqual([
          "implement-0",
          "check-0",
          "implement-1",
          "check-1",
          "review-1",
          "implement-2",
          "check-2",
          "review-2",
          "commit",
        ]);
        expect(reasons.slice(1)).toEqual([
          "type error",
          "button cannot be reached with the keyboard",
        ]);
        expect(result).toEqual({ issue: 1, branch: "selected-pr", sha: "accepted-sha" });
      }),
  );

  it.effect("stops at the repair limit and preserves the branch without a commit", () =>
    Effect.gen(function* () {
      const rounds: Array<number> = [];
      let committed = false;
      const result = yield* Effect.exit(
        reviewIssue({
          issue: 1,
          branch: "preserved-branch",
          repairs: 1,
          delivery: {
            implement: (round) =>
              Effect.sync(() => {
                rounds.push(round);
              }),
            check: () => Effect.succeed({ passed: true, details: "checks passed" }),
            review: () => Effect.succeed({ passed: false, details: "UI is broken" }),
            commit: () =>
              Effect.sync(() => {
                committed = true;
                return "unexpected";
              }),
          },
        }),
      );
      expect(rounds).toEqual([0, 1]);
      expect(committed).toBe(false);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(String(result.cause)).toContain("preserved-branch");
    }),
  );
});
