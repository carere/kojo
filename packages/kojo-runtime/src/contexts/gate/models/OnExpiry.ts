import { type Duration, Schema } from "effect";

/** The three branches a run can take when a deadline passes. Named on the record and the CLI. */
export const ExpiryBranch = Schema.Literals(["fail", "reject", "escalate"]);
export type ExpiryBranch = typeof ExpiryBranch.Type;

/**
 * What the run does when nobody answers in time. Declared with the gate, never inferred.
 *
 * A discriminated union rather than three bare strings, because two of the branches need a value
 * to be executable: an auto-reject has to say *which* choice it stands in for — there is no generic
 * way to know which of `["approve", "reject"]` means no — and an escalation has to name who it goes
 * to and how long that second asking gets.
 */
export type OnExpiry =
  /** End the branch of the workflow that assumed an answer, with `GateExpired`. */
  | { readonly _tag: "fail" }
  /** Answer on the human's behalf, so the author's normal rejection path handles it. */
  | { readonly _tag: "reject"; readonly choice: string; readonly reason: string }
  /** Ask somebody else once. If that asking also expires, the gate fails. */
  | { readonly _tag: "escalate"; readonly to: string; readonly deadline: Duration.Input };

/** @public */
export const fail = (): OnExpiry => ({ _tag: "fail" });

/** @public */
export const reject = (options: {
  readonly choice: string;
  readonly reason: string;
}): OnExpiry => ({
  _tag: "reject",
  choice: options.choice,
  reason: options.reason,
});

/** @public */
export const escalate = (options: {
  readonly to: string;
  readonly deadline: Duration.Input;
}): OnExpiry => ({ _tag: "escalate", to: options.to, deadline: options.deadline });
