import { Console, Effect, Array as EffectArray, Order } from "effect";
import { decodeJson } from "../../shared/decoding";
import { runText } from "../../shared/process";
import {
  type DeliveryOptions,
  type DeliveryWorkstream,
  TrackerIssue,
  TrackerIssueArray,
} from "../../types/delivery";
import { WorkflowError } from "../../types/errors";
import { deliveryCompletionComment } from "./evidence";
import { issueLabelNames } from "./issue";
import { hasDeliveryMetadataHeading } from "./metadata";
import type { DeliveryRepository } from "./repository";
import { buildDeliveryWorkstream } from "./workstream";

const READY_LABEL = "ready-for-agent";
const MAX_DISCOVERY_ISSUES = 1_000;
const HYDRATION_CONCURRENCY = 8;
const ISSUE_FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "stateReason",
  "url",
  "labels",
  "assignees",
  "comments",
  "parent",
  "blockedBy",
  "subIssues",
].join(",");

const viewIssue = Effect.fn("viewIssue")(function* (
  repositoryRoot: string,
  issue: number | string,
) {
  const output = yield* runText(
    ["gh", "issue", "view", String(issue), "--json", ISSUE_FIELDS],
    repositoryRoot,
  );
  return yield* decodeJson(TrackerIssue, `gh issue view ${issue}`, output);
});

export const closeIssueAsCompleted = Effect.fn("closeIssueAsCompleted")(function* (
  repositoryRoot: string,
  ticket: TrackerIssue,
  targetBranch: string,
  targetCommit: string,
) {
  const identifier = ticket.url ?? ticket.number;
  yield* runText(
    [
      "gh",
      "issue",
      "close",
      String(identifier),
      "--reason",
      "completed",
      "--comment",
      deliveryCompletionComment(ticket.number, targetBranch, targetCommit),
    ],
    repositoryRoot,
  );
  const closed = yield* viewIssue(repositoryRoot, identifier);
  if (
    closed.state.toUpperCase() !== "CLOSED" ||
    closed.stateReason?.toUpperCase() !== "COMPLETED"
  ) {
    return yield* new WorkflowError({
      message: `Issue #${ticket.number} did not close as completed`,
      operation: "delivery.closeIssueAsCompleted",
    });
  }
});

const listOpenDeliveryCandidates = Effect.fn("listOpenDeliveryCandidates")(function* (
  repositoryRoot: string,
) {
  const output = yield* runText(
    [
      "gh",
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      String(MAX_DISCOVERY_ISSUES),
      "--json",
      ISSUE_FIELDS,
    ],
    repositoryRoot,
  );
  const issues = yield* decodeJson(TrackerIssueArray, "gh issue list", output);
  if (issues.length === MAX_DISCOVERY_ISSUES) {
    return yield* new WorkflowError({
      message: `Open issue discovery reached the ${MAX_DISCOVERY_ISSUES}-issue safety limit`,
      operation: "delivery.listOpenDeliveryCandidates",
    });
  }
  return issues.filter(
    (issue) =>
      issueLabelNames(issue).includes(READY_LABEL) ||
      (!issue.parent && issue.subIssues.totalCount > 0 && hasDeliveryMetadataHeading(issue.body)),
  );
});

export const loadWorkstream = Effect.fn("loadWorkstream")(function* (
  repository: DeliveryRepository,
  rootNumber: number,
) {
  const root = yield* viewIssue(repository.rootPath, rootNumber);
  if (root.subIssues.totalCount === 0) {
    return yield* buildDeliveryWorkstream(
      root,
      [root],
      repository.githubName,
      repository.githubLogin,
    );
  }
  if (root.subIssues.totalCount !== root.subIssues.nodes.length) {
    return yield* new WorkflowError({
      message: `Workstream root #${root.number} exposes a truncated child graph`,
      operation: "delivery.loadWorkstream",
    });
  }

  const tickets = yield* Effect.forEach(
    root.subIssues.nodes,
    (child) => viewIssue(repository.rootPath, child.url ?? child.number),
    { concurrency: HYDRATION_CONCURRENCY },
  );
  return yield* buildDeliveryWorkstream(
    root,
    tickets,
    repository.githubName,
    repository.githubLogin,
  );
});

export const discoverWorkstreams = Effect.fn("discoverWorkstreams")(function* (
  repository: DeliveryRepository,
  options: DeliveryOptions,
) {
  const automatic = options.root === undefined;
  const rootNumbers = new Set(
    automatic
      ? (yield* listOpenDeliveryCandidates(repository.rootPath)).map(
          (issue) => issue.parent?.number ?? issue.number,
        )
      : [options.root],
  );
  const workstreams: ReadonlyArray<DeliveryWorkstream> = automatic
    ? yield* Effect.gen(function* () {
        const attempts = yield* Effect.forEach(
          rootNumbers,
          (rootNumber) =>
            loadWorkstream(repository, rootNumber).pipe(
              Effect.map((workstream) => ({ _tag: "Discovered", rootNumber, workstream }) as const),
              Effect.catchTag("WorkflowError", (error) =>
                Effect.succeed({ _tag: "Invalid", error, rootNumber } as const),
              ),
            ),
          { concurrency: HYDRATION_CONCURRENCY },
        );
        const discovered: Array<DeliveryWorkstream> = [];
        for (const attempt of attempts) {
          if (attempt._tag === "Discovered") discovered.push(attempt.workstream);
          else
            yield* Console.error(
              `Skipping workstream #${attempt.rootNumber}: ${attempt.error.message}`,
            );
        }
        if (attempts.length > 0 && discovered.length === 0) {
          const firstFailure = attempts.find((attempt) => attempt._tag === "Invalid");
          if (firstFailure?.error) return yield* firstFailure.error;
        }
        return discovered;
      })
    : yield* Effect.forEach(rootNumbers, (rootNumber) => loadWorkstream(repository, rootNumber), {
        concurrency: HYDRATION_CONCURRENCY,
      });
  const selected = workstreams.filter(
    ({ delivery }) => options.target === undefined || delivery.targetBranch === options.target,
  );

  const targetOwners = new Map<string, number>();
  for (const workstream of selected) {
    const target = workstream.delivery.targetBranch;
    const existingRoot = targetOwners.get(target);
    if (existingRoot !== undefined && existingRoot !== workstream.root.number) {
      return yield* new WorkflowError({
        message: `Target '${target}' is shared by roots #${existingRoot} and #${workstream.root.number}`,
        operation: "delivery.discoverWorkstreams",
      });
    }
    targetOwners.set(target, workstream.root.number);
  }

  return EffectArray.sortWith(selected, (workstream) => workstream.root.number, Order.Number);
});
