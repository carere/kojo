import { createHash } from "node:crypto";
import { Effect } from "effect";
import { runText } from "../../shared/process";
import type {
  DeliveryMetadata,
  DeliveryWorkstream,
  PreparedTarget,
  ReviewedIssue,
  TrackerIssue,
} from "../../types/delivery";
import { WorkflowError } from "../../types/errors";

const EVIDENCE_MARKER = "Sandcastle-Delivery-Evidence";
const VERSION_TRAILER = "Sandcastle-Evidence-Version";
const REPOSITORY_TRAILER = "Sandcastle-Repository";
const DELIVERY_ACTOR_TRAILER = "Sandcastle-Delivery-Actor";
const ROOT_TRAILER = "Sandcastle-Delivery-Root";
const ISSUE_TRAILER = "Sandcastle-Delivery-Issue";
const REVIEWED_COMMIT_TRAILER = "Sandcastle-Reviewed-Commit";
const SPECIFICATION_TRAILER = "Sandcastle-Specification-Fingerprint";
const TARGET_BRANCH_TRAILER = "Sandcastle-Target-Branch";
const DESTINATION_BRANCH_TRAILER = "Sandcastle-Destination-Branch";
const SOURCE_REVISION_TRAILER = "Sandcastle-Source-Revision";

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const EVIDENCE_VERSION = "1";

export interface DeliveryMergeEvidence {
  readonly destinationBranch: string;
  readonly deliveryActor: string;
  readonly issueNumber: number;
  readonly mergeCommit: string;
  readonly reviewedCommit: string;
  readonly repository: string;
  readonly rootNumber: number;
  readonly sourceRevision: string;
  readonly specificationFingerprint: string;
  readonly targetBranch: string;
}

export const deliveryCompletionComment = (
  ticketNumber: number,
  targetBranch: string,
  mergeCommit: string,
) =>
  `Integrated by Sandcastle into ${targetBranch} at ${mergeCommit}\n<!-- sandcastle-delivery-completion:v1 ${JSON.stringify({ issue: ticketNumber, mergeCommit, targetBranch })} -->`;

const specificationComments = (issue: TrackerIssue, completionEvidence?: DeliveryMergeEvidence) => {
  const trustedCompletion = completionEvidence
    ? deliveryCompletionComment(
        issue.number,
        completionEvidence.targetBranch,
        completionEvidence.mergeCommit,
      )
    : undefined;
  let ignoredTrustedCompletion = false;
  return issue.comments.filter((comment) => {
    const trusted =
      !ignoredTrustedCompletion &&
      Boolean(trustedCompletion) &&
      issue.state.toUpperCase() === "CLOSED" &&
      issue.stateReason?.toUpperCase() === "COMPLETED" &&
      Boolean(completionEvidence?.deliveryActor) &&
      comment.author?.login === completionEvidence?.deliveryActor &&
      comment.body === trustedCompletion;
    if (trusted) ignoredTrustedCompletion = true;
    return !trusted;
  });
};

const relationIdentity = (
  repository: string,
  relation: { number: number; repository?: string },
) => ({
  number: relation.number,
  repository: relation.repository ?? repository,
});

const sortedRelations = (
  repository: string,
  relations: ReadonlyArray<{ number: number; repository?: string }>,
) =>
  relations
    .map((relation) => relationIdentity(repository, relation))
    .sort((left, right) =>
      left.repository === right.repository
        ? left.number - right.number
        : left.repository.localeCompare(right.repository),
    );

const issueSpecification = (
  workstream: DeliveryWorkstream,
  issue: TrackerIssue,
  completionEvidence?: DeliveryMergeEvidence,
) => ({
  blockedBy: sortedRelations(workstream.repository ?? "", issue.blockedBy.nodes),
  body: issue.body.replaceAll("\r\n", "\n"),
  comments: specificationComments(issue, completionEvidence).map(({ author, body }) => ({
    author: author?.login ?? null,
    body: body.replaceAll("\r\n", "\n"),
  })),
  number: issue.number,
  parent: issue.parent ? relationIdentity(workstream.repository ?? "", issue.parent) : null,
  subIssues: sortedRelations(workstream.repository ?? "", issue.subIssues.nodes),
  title: issue.title,
});

export const deliverySpecificationFingerprint = (
  workstream: DeliveryWorkstream,
  ticket: TrackerIssue,
  completionEvidence?: DeliveryMergeEvidence,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        delivery: {
          destinationBranch: workstream.delivery.destinationBranch,
          sourceRevision: workstream.delivery.sourceRevision,
          targetBranch: workstream.delivery.targetBranch,
        },
        repository: workstream.repository ?? "",
        root: issueSpecification(workstream, workstream.root),
        ticket: issueSpecification(workstream, ticket, completionEvidence),
        version: 1,
      }),
    )
    .digest("hex");

export const deliveryMergeMessage = (workstream: DeliveryWorkstream, reviewed: ReviewedIssue) =>
  [
    `feat(delivery): integrate #${reviewed.issue.number}`,
    "",
    `${EVIDENCE_MARKER}: integrate #${reviewed.issue.number}`,
    "",
    `${ROOT_TRAILER}: ${workstream.root.number}`,
    `${ISSUE_TRAILER}: ${reviewed.issue.number}`,
    `${REVIEWED_COMMIT_TRAILER}: ${reviewed.reviewedCommit}`,
    `${SPECIFICATION_TRAILER}: ${reviewed.specificationFingerprint}`,
    `${TARGET_BRANCH_TRAILER}: ${workstream.delivery.targetBranch}`,
    `${DESTINATION_BRANCH_TRAILER}: ${workstream.delivery.destinationBranch}`,
    `${SOURCE_REVISION_TRAILER}: ${workstream.delivery.sourceRevision}`,
    `${VERSION_TRAILER}: ${EVIDENCE_VERSION}`,
    `${REPOSITORY_TRAILER}: ${workstream.repository || "-"}`,
    `${DELIVERY_ACTOR_TRAILER}: ${workstream.deliveryActor || "-"}`,
  ].join("\n");

const trailer = (message: string, name: string) => {
  const values = message
    .split("\n")
    .filter((line) => line.startsWith(`${name}: `))
    .map((line) => line.slice(name.length + 2));
  return values.length === 1 ? values[0] : undefined;
};

const parseEvidence = (
  message: string,
  mergeCommit: string,
  secondParent: string,
): DeliveryMergeEvidence | undefined => {
  const markers = message.split("\n").filter((line) => line.startsWith(`${EVIDENCE_MARKER}: `));
  if (markers.length !== 1) return undefined;
  const rootNumber = Number(trailer(message, ROOT_TRAILER));
  const issueNumber = Number(trailer(message, ISSUE_TRAILER));
  const reviewedCommit = trailer(message, REVIEWED_COMMIT_TRAILER);
  const specificationFingerprint = trailer(message, SPECIFICATION_TRAILER);
  const targetBranch = trailer(message, TARGET_BRANCH_TRAILER);
  const destinationBranch = trailer(message, DESTINATION_BRANCH_TRAILER);
  const sourceRevision = trailer(message, SOURCE_REVISION_TRAILER);
  const version = trailer(message, VERSION_TRAILER);
  const repository = trailer(message, REPOSITORY_TRAILER);
  const deliveryActor = trailer(message, DELIVERY_ACTOR_TRAILER);
  if (
    !Number.isInteger(rootNumber) ||
    rootNumber < 1 ||
    !Number.isInteger(issueNumber) ||
    issueNumber < 1 ||
    !reviewedCommit ||
    !SHA_PATTERN.test(reviewedCommit) ||
    reviewedCommit !== secondParent ||
    !specificationFingerprint ||
    !FINGERPRINT_PATTERN.test(specificationFingerprint) ||
    !targetBranch ||
    !destinationBranch ||
    !sourceRevision ||
    !SHA_PATTERN.test(sourceRevision) ||
    version !== EVIDENCE_VERSION ||
    repository === undefined ||
    deliveryActor === undefined
  ) {
    return undefined;
  }
  return {
    destinationBranch,
    deliveryActor,
    issueNumber,
    mergeCommit,
    reviewedCommit,
    repository,
    rootNumber,
    sourceRevision,
    specificationFingerprint,
    targetBranch,
  };
};

const hasExpectedMetadata = (
  evidence: DeliveryMergeEvidence,
  delivery: DeliveryMetadata,
  repository: string,
) =>
  evidence.targetBranch === delivery.targetBranch &&
  evidence.destinationBranch === delivery.destinationBranch &&
  evidence.sourceRevision === delivery.sourceRevision &&
  evidence.repository === (repository || "-");

export const readDeliveryMergeEvidence = Effect.fn("readDeliveryMergeEvidence")(function* (
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
  ticket: TrackerIssue,
  mergeCommit: string,
  secondParent: string,
) {
  const message = yield* runText(["git", "show", "-s", "--format=%B", mergeCommit], target.path);
  const evidence = parseEvidence(message, mergeCommit, secondParent);
  if (!evidence) {
    return yield* new WorkflowError({
      message: `Ticket #${ticket.number} has malformed durable integration evidence`,
      operation: "delivery.readDeliveryMergeEvidence",
    });
  }
  if (evidence.rootNumber !== workstream.root.number || evidence.issueNumber !== ticket.number) {
    return yield* new WorkflowError({
      message: `Merge ${mergeCommit} carries evidence for another delivery ticket`,
      operation: "delivery.readDeliveryMergeEvidence",
    });
  }
  if (!hasExpectedMetadata(evidence, workstream.delivery, workstream.repository ?? "")) {
    return yield* new WorkflowError({
      message: `Ticket #${ticket.number} durable integration evidence has changed Delivery metadata`,
      operation: "delivery.readDeliveryMergeEvidence",
    });
  }
  const expectedFingerprint = deliverySpecificationFingerprint(workstream, ticket, evidence);
  if (evidence.specificationFingerprint !== expectedFingerprint) {
    return yield* new WorkflowError({
      message: `Ticket #${ticket.number} or root #${workstream.root.number} changed after integration`,
      operation: "delivery.readDeliveryMergeEvidence",
    });
  }
  return evidence;
});

export const findDeliveryMergeEvidence = Effect.fn("findDeliveryMergeEvidence")(function* (
  target: PreparedTarget,
  workstream: DeliveryWorkstream,
  ticket: TrackerIssue,
) {
  const history = yield* runText(
    [
      "git",
      "rev-list",
      "--first-parent",
      "--merges",
      "--parents",
      `${workstream.delivery.sourceRevision}..HEAD`,
    ],
    target.path,
  );
  for (const line of history.split("\n").filter(Boolean)) {
    const parents = line.split(/\s+/);
    if (parents.length !== 3) continue;
    const [mergeCommit, firstParent, secondParent] = parents;
    if (!mergeCommit || !firstParent || !secondParent) continue;
    const message = yield* runText(["git", "show", "-s", "--format=%B", mergeCommit], target.path);
    if (!message.includes(`${EVIDENCE_MARKER}:`)) continue;
    const evidence = parseEvidence(message, mergeCommit, secondParent);
    const rawRoot = Number(trailer(message, ROOT_TRAILER));
    const rawIssue = Number(trailer(message, ISSUE_TRAILER));
    const belongsToTicket = rawRoot === workstream.root.number && rawIssue === ticket.number;
    if (!evidence) {
      if (belongsToTicket || !Number.isInteger(rawRoot) || !Number.isInteger(rawIssue)) {
        return yield* new WorkflowError({
          message: `Ticket #${ticket.number} has malformed durable integration evidence`,
          operation: "delivery.findDeliveryMergeEvidence",
        });
      }
      continue;
    }
    if (evidence.rootNumber !== workstream.root.number || evidence.issueNumber !== ticket.number) {
      continue;
    }
    if (!hasExpectedMetadata(evidence, workstream.delivery, workstream.repository ?? "")) {
      return yield* new WorkflowError({
        message: `Ticket #${ticket.number} durable integration evidence has changed Delivery metadata`,
        operation: "delivery.findDeliveryMergeEvidence",
      });
    }
    const expectedFingerprint = deliverySpecificationFingerprint(workstream, ticket, evidence);
    if (evidence.specificationFingerprint !== expectedFingerprint) {
      return yield* new WorkflowError({
        message: `Ticket #${ticket.number} or root #${workstream.root.number} changed after integration`,
        operation: "delivery.findDeliveryMergeEvidence",
      });
    }
    return evidence;
  }
  return undefined;
});
