import * as sandcastle from "@ai-hero/sandcastle";
import { Effect, Schema } from "effect";
import { tryExternalPromise } from "../../../shared/external-failure";
import { runText } from "../../../shared/process";
import {
  type DeliveryWorkstream,
  PlannerSelection,
  type PreparedTarget,
  type TrackerIssue,
} from "../../../types/delivery";
import { WorkflowError } from "../../../types/errors";
import { ensureCleanWorktree } from "../target";
import { createSandboxProvider, hooks, prompts } from "./config";
import { issuePromptValue, serializeIssuePrompt } from "./issue-context";

export const validatePlannerSelection = Effect.fn("validatePlannerSelection")(function* (
  selection: PlannerSelection,
  candidateIds: ReadonlyArray<string>,
  concurrency: number,
) {
  if (selection.issueIds.length === 0) {
    return yield* new WorkflowError({
      message: "Planner returned no issue from a non-empty frontier",
      operation: "delivery.validatePlannerSelection",
    });
  }
  if (selection.issueIds.length > concurrency) {
    return yield* new WorkflowError({
      message: "Planner exceeded the concurrency limit",
      operation: "delivery.validatePlannerSelection",
    });
  }
  if (new Set(selection.issueIds).size !== selection.issueIds.length) {
    return yield* new WorkflowError({
      message: "Planner returned duplicate issues",
      operation: "delivery.validatePlannerSelection",
    });
  }

  const candidates = new Set(candidateIds);
  const outOfScope = selection.issueIds.find((id) => !candidates.has(id));
  if (outOfScope) {
    return yield* new WorkflowError({
      message: `Planner returned out-of-scope issue #${outOfScope}`,
      operation: "delivery.validatePlannerSelection",
    });
  }
  return selection.issueIds;
});

export const planFrontier = Effect.fn("planFrontier")(function* (
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
  frontier: ReadonlyArray<TrackerIssue>,
  concurrency: number,
) {
  const before = yield* runText(["git", "rev-parse", "HEAD"], target.path);
  const result = yield* tryExternalPromise(
    "sandcastle",
    `plan workstream ${workstream.root.number}`,
    (signal) =>
      sandcastle.run({
        agent: sandcastle.codex("gpt-5.6-sol", { effort: "high" }),
        branchStrategy: { type: "head" },
        cwd: target.path,
        hooks,
        maxIterations: 1,
        name: `planner-${workstream.root.number}`,
        output: sandcastle.Output.object({
          schema: Schema.toStandardSchemaV1(PlannerSelection),
          tag: "plan",
        }),
        promptArgs: {
          BASE_SHA: target.baseSha,
          CONCURRENCY: concurrency,
          DELIVERY_TARGET_BRANCH: target.branch,
          FRONTIER_ISSUES: JSON.stringify(frontier.map(issuePromptValue), null, 2),
          ROOT_ISSUE: serializeIssuePrompt(workstream.root),
        },
        promptFile: prompts.planner,
        sandbox: createSandboxProvider(),
        signal,
      }),
  );

  const after = yield* runText(["git", "rev-parse", "HEAD"], target.path);
  if (result.commits.length > 0 || after !== before) {
    return yield* new WorkflowError({
      message: "Planner modified the target branch",
      operation: "delivery.planFrontier",
    });
  }
  yield* ensureCleanWorktree(target.path);
  return yield* validatePlannerSelection(
    result.output,
    frontier.map(({ number }) => String(number)),
    concurrency,
  );
});
