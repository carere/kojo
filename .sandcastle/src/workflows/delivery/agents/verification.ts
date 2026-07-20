import { randomUUID } from "node:crypto";
import * as sandcastle from "@ai-hero/sandcastle";
import { Effect } from "effect";
import { tryExternalPromise } from "../../../shared/external-failure";
import { runRequired } from "../../../shared/process";
import type {
  DeliveryWorkstream,
  IntegrationFailureKind,
  PreparedTarget,
  ReviewedIssue,
} from "../../../types/delivery";
import { WorkflowError } from "../../../types/errors";
import { ensureCleanWorktree } from "../target";
import { createSandboxProvider, hooks, prompts } from "./config";
import { serializeIssuePrompt } from "./issue-context";
import { parseReviewDecision } from "./review-decision";
import { runTargetAgent, runVerificationChecks, sandboxRequired } from "./runtime";

export const runVerificationSandbox = Effect.fn("runVerificationSandbox")(function* (
  repositoryRoot: string,
  workstream: DeliveryWorkstream,
  targetCommit: string,
) {
  const branch = `sandcastle/verify-${workstream.root.number}-${targetCommit}-${randomUUID()}`;
  return yield* Effect.acquireUseRelease(
    tryExternalPromise("sandcastle", `create verification for ${workstream.root.number}`, () =>
      sandcastle.createSandbox({
        baseBranch: targetCommit,
        branch,
        cwd: repositoryRoot,
        hooks,
        sandbox: createSandboxProvider(),
      }),
    ),
    (sandbox) =>
      Effect.gen(function* () {
        const verificationHead = yield* sandboxRequired(
          sandbox,
          "git rev-parse HEAD",
          "verification HEAD",
        );
        if (verificationHead !== targetCommit) {
          return yield* new WorkflowError({
            message: `Verification sandbox for #${workstream.root.number} is at ${verificationHead}, expected ${targetCommit}`,
            operation: "delivery.runVerificationSandbox",
          });
        }
        yield* runVerificationChecks(sandbox);
        yield* sandboxRequired(
          sandbox,
          'test -z "$(git status --porcelain)"',
          "verification cleanliness",
        );
      }),
    (sandbox) =>
      tryExternalPromise("sandcastle", `close verification for ${workstream.root.number}`, () =>
        sandbox.close(),
      ).pipe(
        Effect.flatMap((closed) => {
          if (closed.preservedWorktreePath) {
            return new WorkflowError({
              message: `Verification worktree was preserved dirty at ${closed.preservedWorktreePath}`,
              operation: "delivery.runVerificationSandbox",
            });
          }
          return runRequired(["git", "branch", "-D", branch], repositoryRoot).pipe(Effect.asVoid);
        }),
      ),
  );
});

export const runMergeRepair = Effect.fn("runMergeRepair")(function* (
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
  issue: ReviewedIssue,
  failureKind: typeof IntegrationFailureKind.Type,
  failureOutput: string,
) {
  const result = yield* runTargetAgent(
    target,
    `integrate-${issue.issue.number}`,
    40,
    sandcastle.codex("gpt-5.6-sol", { effort: "high" }),
    prompts.integrationRepair,
    {
      DELIVERY_TARGET_BRANCH: target.branch,
      FAILURE_KIND: failureKind,
      FAILURE_OUTPUT: failureOutput,
      ISSUE_BRANCH: issue.branch,
      ISSUE_CONTEXT: serializeIssuePrompt(issue.issue),
      ROOT_CONTEXT: serializeIssuePrompt(workstream.root),
    },
  );
  if (!result.completionSignal) {
    return yield* new WorkflowError({
      message: `Integration repair for #${issue.issue.number} did not report completion`,
      operation: "delivery.runMergeRepair",
    });
  }
  yield* ensureCleanWorktree(target.path);

  const review = yield* runTargetAgent(
    target,
    `review-integration-${issue.issue.number}`,
    20,
    sandcastle.codex("gpt-5.6-sol", { effort: "high" }),
    prompts.reviewer,
    {
      BASE_SHA: target.baseSha,
      BRANCH: target.branch,
      DELIVERY_TARGET_BRANCH: target.branch,
      ISSUE_CONTEXT: serializeIssuePrompt(issue.issue),
      ROOT_CONTEXT: serializeIssuePrompt(workstream.root),
      TASK_ID: issue.issue.number,
    },
  );
  if (!review.completionSignal) {
    return yield* new WorkflowError({
      message: `Integration repair reviewer for #${issue.issue.number} did not report completion`,
      operation: "delivery.runMergeRepair",
    });
  }
  const decision = yield* parseReviewDecision(review.stdout);
  if (!decision.readyToMerge) {
    return yield* new WorkflowError({
      message: `Integration repair review rejected #${issue.issue.number}: ${decision.summary}`,
      operation: "delivery.runMergeRepair",
    });
  }
  yield* ensureCleanWorktree(target.path);
});
