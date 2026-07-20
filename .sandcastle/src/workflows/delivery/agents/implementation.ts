import * as sandcastle from "@ai-hero/sandcastle";
import { Console, Effect } from "effect";
import { tryExternalPromise } from "../../../shared/external-failure";
import { quoteShellArgument } from "../../../shared/process";
import {
  type DeliveryWorkstream,
  type PreparedTarget,
  ReviewedIssue,
  type TrackerIssue,
} from "../../../types/delivery";
import { WorkflowError } from "../../../types/errors";
import { deliverySpecificationFingerprint } from "../evidence";
import { issueBranchName } from "../issue";
import { createSandboxProvider, hooks, prompts } from "./config";
import { serializeIssuePrompt } from "./issue-context";
import { parseReviewDecision } from "./review-decision";
import { runSandboxChecks, sandboxRequired } from "./runtime";

export const implementAndReview = Effect.fn("implementAndReview")(function* (
  repositoryRoot: string,
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
  issue: TrackerIssue,
) {
  const branch = issueBranchName(workstream.root.number, issue.number);
  return yield* Effect.acquireUseRelease(
    tryExternalPromise("sandcastle", `create worker for issue ${issue.number}`, () =>
      sandcastle.createSandbox({
        baseBranch: target.baseSha,
        branch,
        cwd: repositoryRoot,
        hooks,
        sandbox: createSandboxProvider(),
      }),
    ),
    (sandbox) =>
      Effect.gen(function* () {
        yield* sandboxRequired(
          sandbox,
          'test -z "$(git status --porcelain)"',
          "worker cleanliness",
        );
        const implementation = yield* tryExternalPromise(
          "sandcastle",
          `implement issue ${issue.number}`,
          (signal) =>
            sandbox.run({
              agent: sandcastle.codex("gpt-5.6-sol", { effort: "medium" }),
              maxIterations: 100,
              name: `implement-${issue.number}`,
              promptArgs: {
                BASE_SHA: target.baseSha,
                BRANCH: branch,
                DELIVERY_TARGET_BRANCH: target.branch,
                DESTINATION_BRANCH: workstream.delivery.destinationBranch,
                ISSUE_CONTEXT: serializeIssuePrompt(issue),
                ISSUE_TITLE: issue.title,
                ROOT_CONTEXT: serializeIssuePrompt(workstream.root),
                ROOT_ID: workstream.root.number,
                TASK_ID: issue.number,
              },
              promptFile: prompts.implementer,
              signal,
            }),
        );
        if (!implementation.completionSignal) {
          return yield* new WorkflowError({
            message: `Implementer for #${issue.number} did not report completion`,
            operation: "delivery.implementAndReview",
          });
        }

        const ahead = Number(
          yield* sandboxRequired(
            sandbox,
            `git rev-list --count ${quoteShellArgument(target.baseSha)}..HEAD`,
            "worker commit check",
          ),
        );
        if (!Number.isInteger(ahead) || ahead < 1) {
          return yield* new WorkflowError({
            message: `Issue #${issue.number} produced no commits beyond ${target.baseSha}`,
            operation: "delivery.implementAndReview",
          });
        }
        const implementationHead = yield* sandboxRequired(
          sandbox,
          "git rev-parse HEAD",
          "implemented issue HEAD",
        );

        const review = yield* tryExternalPromise(
          "sandcastle",
          `review issue ${issue.number}`,
          (signal) =>
            sandbox.run({
              agent: sandcastle.codex("gpt-5.6-sol", { effort: "high" }),
              maxIterations: 20,
              name: `review-${issue.number}`,
              promptArgs: {
                BASE_SHA: target.baseSha,
                BRANCH: branch,
                DELIVERY_TARGET_BRANCH: target.branch,
                ISSUE_CONTEXT: serializeIssuePrompt(issue),
                ROOT_CONTEXT: serializeIssuePrompt(workstream.root),
                TASK_ID: issue.number,
              },
              promptFile: prompts.reviewer,
              signal,
            }),
        );
        if (!review.completionSignal) {
          return yield* new WorkflowError({
            message: `Reviewer for #${issue.number} did not report completion`,
            operation: "delivery.implementAndReview",
          });
        }
        const decision = yield* parseReviewDecision(review.stdout);
        if (!decision.readyToMerge) {
          return yield* new WorkflowError({
            message: `Review rejected #${issue.number}: ${decision.summary}`,
            operation: "delivery.implementAndReview",
          });
        }

        const reviewedAhead = Number(
          yield* sandboxRequired(
            sandbox,
            `git rev-list --count ${quoteShellArgument(target.baseSha)}..HEAD`,
            "reviewed commit check",
          ),
        );
        if (!Number.isInteger(reviewedAhead) || reviewedAhead < 1) {
          return yield* new WorkflowError({
            message: `Review of #${issue.number} left no commits beyond ${target.baseSha}`,
            operation: "delivery.implementAndReview",
          });
        }

        yield* runSandboxChecks(sandbox);
        yield* sandboxRequired(
          sandbox,
          `git merge-base --is-ancestor ${quoteShellArgument(target.baseSha)} HEAD`,
          "worker ancestry",
        );
        yield* sandboxRequired(
          sandbox,
          `git merge-base --is-ancestor ${quoteShellArgument(implementationHead)} HEAD`,
          "reviewed implementation ancestry",
        );
        yield* sandboxRequired(
          sandbox,
          'test -z "$(git status --porcelain)"',
          "worker cleanliness",
        );
        const reviewedCommit = yield* sandboxRequired(sandbox, "git rev-parse HEAD", "worker HEAD");
        return new ReviewedIssue({
          branch,
          issue,
          reviewedCommit,
          specificationFingerprint: deliverySpecificationFingerprint(workstream, issue),
        });
      }),
    (sandbox) =>
      tryExternalPromise("sandcastle", `close worker for issue ${issue.number}`, () =>
        sandbox.close(),
      ).pipe(
        Effect.flatMap((closed) =>
          closed.preservedWorktreePath
            ? Console.error(`  Preserved dirty worker worktree: ${closed.preservedWorktreePath}`)
            : Effect.void,
        ),
      ),
  );
});
