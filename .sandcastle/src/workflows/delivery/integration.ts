import { Console, Effect } from "effect";
import { failureMessage } from "../../shared/external-failure";
import { processFailure, runProcess, runRequired, runText } from "../../shared/process";
import {
  type DeliveryWorkstream,
  PreparedTarget,
  ReviewedIssue,
  type TrackerIssue,
} from "../../types/delivery";
import { WorkflowError } from "../../types/errors";
import {
  deliveryMergeMessage,
  deliverySpecificationFingerprint,
  findDeliveryMergeEvidence,
  readDeliveryMergeEvidence,
} from "./evidence";
import { hasSameIssueSpecification, isCompletedIssue, issueBranchName } from "./issue";
import { hasSameDeliveryMetadata } from "./metadata";
import type { DeliveryRepository } from "./repository";
import { DeliveryAgents, DeliveryTracker } from "./services";
import { beginTargetIntegration, ensureCleanWorktree, publishTargetCommit } from "./target";
import { selectReadyFrontier } from "./workstream";

const assertIntegrationEvidence = Effect.fn("assertIntegrationEvidence")(function* (
  target: PreparedTarget,
  expectedTargetHead: string,
  reviewedCommit: string,
) {
  const mergeHead = yield* runProcess(
    ["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"],
    target.path,
  );
  if (mergeHead.exitCode === 0) {
    return yield* new WorkflowError({
      message: `Integration into '${target.branch}' is unfinished`,
      operation: "delivery.assertIntegrationEvidence",
    });
  }
  yield* runRequired(
    ["git", "merge-base", "--is-ancestor", expectedTargetHead, "HEAD"],
    target.path,
  );
  yield* runRequired(["git", "merge-base", "--is-ancestor", reviewedCommit, "HEAD"], target.path);
  yield* ensureCleanWorktree(target.path);
  return yield* runText(["git", "rev-parse", "HEAD"], target.path);
});

const assertTargetStillAt = Effect.fn("assertTargetStillAt")(function* (
  target: PreparedTarget,
  verifiedCommit: string,
) {
  const currentCommit = yield* runText(["git", "rev-parse", "HEAD"], target.path);
  if (currentCommit !== verifiedCommit) {
    return yield* new WorkflowError({
      message: `Target '${target.branch}' moved from verified commit ${verifiedCommit} to ${currentCommit}`,
      operation: "delivery.assertTargetStillAt",
    });
  }
});

const findExactFreshMerge = Effect.fn("findExactFreshMerge")(function* (
  target: PreparedTarget,
  reviewedCommit: string,
  expectedTargetHead: string,
) {
  const firstParentMerges = yield* runText(
    ["git", "rev-list", "--first-parent", "--merges", "--parents", `${expectedTargetHead}..HEAD`],
    target.path,
  );
  for (const line of firstParentMerges.split("\n").filter(Boolean)) {
    const [mergeCommit, firstParent, secondParent, ...extraParents] = line.split(/\s+/);
    if (
      mergeCommit &&
      firstParent === expectedTargetHead &&
      secondParent === reviewedCommit &&
      extraParents.length === 0
    ) {
      return mergeCommit;
    }
  }
  return undefined;
});

const assertFreshIntegrationEvidence = Effect.fn("assertFreshIntegrationEvidence")(function* (
  target: PreparedTarget,
  expectedTargetHead: string,
  workstream: DeliveryWorkstream,
  reviewed: ReviewedIssue,
) {
  const targetCommit = yield* assertIntegrationEvidence(
    target,
    expectedTargetHead,
    reviewed.reviewedCommit,
  );
  const mergeCommit = yield* findExactFreshMerge(
    target,
    reviewed.reviewedCommit,
    expectedTargetHead,
  );
  if (!mergeCommit) {
    return yield* new WorkflowError({
      message: `Reviewed commit ${reviewed.reviewedCommit} for issue #${reviewed.issue.number} lacks an exact two-parent merge from ${expectedTargetHead}`,
      operation: "delivery.assertFreshIntegrationEvidence",
    });
  }
  const evidence = yield* readDeliveryMergeEvidence(
    target,
    workstream,
    reviewed.issue,
    mergeCommit,
    reviewed.reviewedCommit,
  );
  if (evidence.reviewedCommit !== reviewed.reviewedCommit) {
    return yield* new WorkflowError({
      message: `Issue #${reviewed.issue.number} lacks matching durable delivery evidence`,
      operation: "delivery.assertFreshIntegrationEvidence",
    });
  }
  return targetCommit;
});

const assertWorkstreamCompletionEvidence = Effect.fn("assertWorkstreamCompletionEvidence")(
  function* (
    target: PreparedTarget,
    workstream: DeliveryWorkstream,
    targetCommit: string,
    completingTicketNumber?: number,
  ) {
    yield* ensureCleanWorktree(target.path);
    yield* assertTargetStillAt(target, targetCommit);

    for (const ticket of workstream.tickets) {
      if (ticket.number !== completingTicketNumber && !isCompletedIssue(ticket)) {
        return yield* new WorkflowError({
          message: `Ticket #${ticket.number} lacks completed delivery evidence`,
          operation: "delivery.assertWorkstreamCompletionEvidence",
        });
      }

      const evidence = yield* findDeliveryMergeEvidence(target, workstream, ticket);
      if (!evidence) {
        return yield* new WorkflowError({
          message: `Ticket #${ticket.number} lacks integration evidence in '${target.branch}'`,
          operation: "delivery.assertWorkstreamCompletionEvidence",
        });
      }
    }
  },
);

const completeIntegratedIssue = Effect.fn("completeIntegratedIssue")(function* (
  repository: DeliveryRepository,
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
  integrated: ReviewedIssue,
  targetCommit: string,
) {
  const tracker = yield* DeliveryTracker;
  const refreshed = yield* tracker.loadWorkstream(repository, workstream.root.number);
  if (!hasSameDeliveryMetadata(workstream.delivery, refreshed.delivery)) {
    return yield* new WorkflowError({
      message: `Workstream #${workstream.root.number} changed Delivery metadata`,
      operation: "delivery.completeIntegratedIssue",
    });
  }
  if (!hasSameIssueSpecification(workstream.root, refreshed.root)) {
    return yield* new WorkflowError({
      message: `Workstream root #${workstream.root.number} changed during execution`,
      operation: "delivery.completeIntegratedIssue",
    });
  }

  const ticket = refreshed.tickets.find(({ number }) => number === integrated.issue.number);
  if (
    !ticket ||
    !selectReadyFrontier(refreshed.tickets).some(({ number }) => number === ticket.number)
  ) {
    return yield* new WorkflowError({
      message: `Issue #${integrated.issue.number} is no longer in the ready frontier`,
      operation: "delivery.completeIntegratedIssue",
    });
  }
  if (!hasSameIssueSpecification(integrated.issue, ticket)) {
    return yield* new WorkflowError({
      message: `Issue #${ticket.number} changed during execution`,
      operation: "delivery.completeIntegratedIssue",
    });
  }
  const evidence = yield* findDeliveryMergeEvidence(target, refreshed, ticket);
  if (!evidence || evidence.reviewedCommit !== integrated.reviewedCommit) {
    return yield* new WorkflowError({
      message: `Issue #${ticket.number} lacks its reviewed durable integration evidence`,
      operation: "delivery.completeIntegratedIssue",
    });
  }

  const isLastOpenTicket = !refreshed.tickets.some(
    (candidate) => candidate.number !== ticket.number && candidate.state.toUpperCase() === "OPEN",
  );
  if (workstream.kind === "standalone") {
    if (isLastOpenTicket) {
      yield* assertWorkstreamCompletionEvidence(target, refreshed, targetCommit, ticket.number);
      yield* tracker.ensurePullRequest(repository, refreshed, targetCommit);
    }
    return;
  }

  if (isLastOpenTicket) {
    yield* assertWorkstreamCompletionEvidence(target, refreshed, targetCommit, ticket.number);
  }

  yield* tracker.closeIssueAsCompleted(
    repository.rootPath,
    ticket,
    workstream.delivery.targetBranch,
    evidence.mergeCommit,
  );
});

export const integrateIssue = Effect.fn("integrateIssue")(function* (
  repository: DeliveryRepository,
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
  integrated: ReviewedIssue,
  expectedTargetHead: string,
) {
  const agents = yield* DeliveryAgents;
  const currentTargetHead = yield* runText(["git", "rev-parse", "HEAD"], target.path);
  if (currentTargetHead !== expectedTargetHead) {
    return yield* new WorkflowError({
      message: `Target '${target.branch}' moved from ${expectedTargetHead} to ${currentTargetHead} during the batch`,
      operation: "delivery.integrateIssue",
    });
  }
  const repairTarget = new PreparedTarget({
    baseSha: expectedTargetHead,
    branch: target.branch,
    path: target.path,
  });

  const expectedFingerprint = deliverySpecificationFingerprint(workstream, integrated.issue);
  if (integrated.specificationFingerprint !== expectedFingerprint) {
    return yield* new WorkflowError({
      message: `Issue #${integrated.issue.number} reviewed evidence does not match its workstream specification`,
      operation: "delivery.integrateIssue",
    });
  }

  yield* beginTargetIntegration(target, expectedTargetHead, integrated.branch);
  const mergeCommand = [
    "git",
    "merge",
    "--no-ff",
    "-m",
    deliveryMergeMessage(workstream, integrated),
    integrated.reviewedCommit,
  ];
  const merge = yield* runProcess(mergeCommand, target.path);
  if (merge.exitCode !== 0) {
    const conflicts = yield* runText(
      ["git", "diff", "--name-only", "--diff-filter=U"],
      target.path,
    );
    if (!conflicts) return yield* processFailure(mergeCommand, merge, target.path);
    yield* agents.repair(
      repairTarget,
      workstream,
      integrated,
      "merge-conflict",
      merge.stderr || merge.stdout,
    );
  }

  let targetCommit = yield* assertFreshIntegrationEvidence(
    target,
    expectedTargetHead,
    workstream,
    integrated,
  );
  yield* agents.verify(repository.rootPath, workstream, targetCommit).pipe(
    Effect.catchTag("VerificationCheckError", (failure) =>
      Effect.gen(function* () {
        yield* agents.repair(
          repairTarget,
          workstream,
          integrated,
          "failed-checks",
          failureMessage(failure),
        );
        targetCommit = yield* assertFreshIntegrationEvidence(
          target,
          expectedTargetHead,
          workstream,
          integrated,
        );
        yield* agents.verify(repository.rootPath, workstream, targetCommit);
      }),
    ),
  );
  yield* assertTargetStillAt(target, targetCommit);
  yield* publishTargetCommit(target, targetCommit);
  yield* completeIntegratedIssue(repository, target, workstream, integrated, targetCommit);
  yield* Console.log(`  ✓ #${integrated.issue.number} integrated at ${targetCommit.slice(0, 12)}`);
  return targetCommit;
});

export const recoverIntegratedIssue = Effect.fn("recoverIntegratedIssue")(function* (
  repository: DeliveryRepository,
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
  issue: TrackerIssue,
) {
  const agents = yield* DeliveryAgents;
  const branch = issueBranchName(workstream.root.number, issue.number);
  const evidence = yield* findDeliveryMergeEvidence(target, workstream, issue);
  if (!evidence) return false;

  const targetCommit = yield* assertIntegrationEvidence(
    target,
    target.baseSha,
    evidence.reviewedCommit,
  );
  yield* agents.verify(repository.rootPath, workstream, targetCommit);
  yield* assertTargetStillAt(target, targetCommit);
  yield* publishTargetCommit(target, targetCommit);
  yield* completeIntegratedIssue(
    repository,
    target,
    workstream,
    new ReviewedIssue({
      branch,
      issue,
      reviewedCommit: evidence.reviewedCommit,
      specificationFingerprint: evidence.specificationFingerprint,
    }),
    targetCommit,
  );
  yield* Console.log(`  ↻ #${issue.number} recovered at ${targetCommit.slice(0, 12)}`);
  return true;
});

export const finalizeCompletedWorkstream = Effect.fn("finalizeCompletedWorkstream")(function* (
  repository: DeliveryRepository,
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
) {
  const agents = yield* DeliveryAgents;
  const tracker = yield* DeliveryTracker;
  if (workstream.tickets.some((ticket) => ticket.state.toUpperCase() === "OPEN")) return false;
  const targetCommit = yield* runText(["git", "rev-parse", "HEAD"], target.path);
  yield* assertWorkstreamCompletionEvidence(target, workstream, targetCommit);

  yield* agents.verify(repository.rootPath, workstream, targetCommit);
  yield* assertTargetStillAt(target, targetCommit);
  const ahead = Number(
    yield* runText(
      ["git", "rev-list", "--count", `${workstream.delivery.destinationBranch}..${targetCommit}`],
      target.path,
    ),
  );
  if (!Number.isInteger(ahead) || ahead < 1) {
    return yield* new WorkflowError({
      message: `Delivery target '${target.branch}' has no commits beyond '${workstream.delivery.destinationBranch}'`,
      operation: "delivery.finalizeCompletedWorkstream",
    });
  }
  yield* publishTargetCommit(target, targetCommit);
  const refreshed = yield* tracker.loadWorkstream(repository, workstream.root.number);
  if (!hasSameDeliveryMetadata(workstream.delivery, refreshed.delivery)) {
    return yield* new WorkflowError({
      message: `Workstream #${workstream.root.number} changed Delivery metadata`,
      operation: "delivery.finalizeCompletedWorkstream",
    });
  }
  yield* assertWorkstreamCompletionEvidence(target, refreshed, targetCommit);
  yield* tracker.ensurePullRequest(repository, refreshed, targetCommit);
  yield* Console.log("Delivery complete. Target retained for preview and pull request review.");
  return true;
});
