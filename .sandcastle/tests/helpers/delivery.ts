import {
  type DeliveryWorkstream,
  ReviewedIssue,
  type TrackerIssue,
} from "../../src/types/delivery";
import {
  deliveryMergeMessage,
  deliverySpecificationFingerprint,
} from "../../src/workflows/delivery/evidence";
import { runGit } from "./git";

export const reviewedIssueFixture = (
  workstream: DeliveryWorkstream,
  issue: TrackerIssue,
  branch: string,
  reviewedCommit: string,
) =>
  new ReviewedIssue({
    branch,
    issue,
    reviewedCommit,
    specificationFingerprint: deliverySpecificationFingerprint(workstream, issue),
  });

export const addDeliveryEvidenceToHead = async (
  repository: string,
  workstream: DeliveryWorkstream,
  issue: TrackerIssue | undefined,
  branch: string,
) => {
  if (!issue) throw new Error("Delivery evidence fixture requires a ticket");
  const reviewedCommit = await runGit(repository, "rev-parse", branch);
  const reviewed = reviewedIssueFixture(workstream, issue, branch, reviewedCommit);
  await runGit(repository, "commit", "--amend", "-m", deliveryMergeMessage(workstream, reviewed));
};
