import { Effect, Schema } from "effect";
import type { AcceptedIssue } from "./runIssueGraph.ts";

export interface ReviewFinding {
  readonly passed: boolean;
  readonly details: string;
}

/** Each operation is a recorded Phase in the example Workflow. */
export interface IssueReview<E, R> {
  readonly implement: (round: number, reason: string) => Effect.Effect<void, E, R>;
  readonly check: (round: number) => Effect.Effect<ReviewFinding, E, R>;
  readonly review: (round: number) => Effect.Effect<ReviewFinding, E, R>;
  readonly commit: () => Effect.Effect<string, E, R>;
}

export class IssueRejected extends Schema.TaggedError<IssueRejected>()("IssueRejected", {
  issue: Schema.Number,
  branch: Schema.String,
  message: Schema.String,
}) {}

/** The initial attempt plus a finite number of repairs. Rejection never deletes the worktree. */
export const reviewIssue = <E, R>(options: {
  readonly issue: number;
  readonly branch: string;
  readonly repairs: number;
  readonly delivery: IssueReview<E, R>;
}): Effect.Effect<AcceptedIssue, E | IssueRejected, R> =>
  Effect.gen(function* () {
    let reason = "Implement the selected issue.";
    if (!Number.isSafeInteger(options.repairs) || options.repairs < 0)
      return yield* new IssueRejected({
        issue: options.issue,
        branch: options.branch,
        message: "The repair limit must be a non-negative integer.",
      });
    for (let round = 0; round <= options.repairs; round++) {
      yield* options.delivery.implement(round, reason);
      const checks = yield* options.delivery.check(round);
      const review = checks.passed ? yield* options.delivery.review(round) : checks;
      if (checks.passed && review.passed) {
        const sha = yield* options.delivery.commit();
        return { issue: options.issue, branch: options.branch, sha };
      }
      reason = review.details;
    }
    return yield* new IssueRejected({
      issue: options.issue,
      branch: options.branch,
      message: `Repair limit reached. Work is preserved on ${options.branch}: ${reason}`,
    });
  });
