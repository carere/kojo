import type { TrackerIssue } from "../../types/delivery";

export const issueLabelNames = (issue: TrackerIssue) => issue.labels.map((label) => label.name);

export const isOpenIssue = (issue: TrackerIssue) => issue.state.toUpperCase() === "OPEN";

export const isCompletedIssue = (issue: TrackerIssue) =>
  issue.state.toUpperCase() === "CLOSED" && issue.stateReason?.toUpperCase() === "COMPLETED";

export const issueBranchName = (rootNumber: number, issueNumber: number) =>
  `sandcastle/workstream-${rootNumber}/issue-${issueNumber}`;

export const hasSameIssueSpecification = (left: TrackerIssue, right: TrackerIssue) =>
  left.title === right.title &&
  left.body === right.body &&
  JSON.stringify(left.comments) === JSON.stringify(right.comments);
