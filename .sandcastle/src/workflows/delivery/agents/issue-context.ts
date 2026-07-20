import type { TrackerIssue } from "../../../types/delivery";

export const issuePromptValue = (issue: TrackerIssue) => ({
  blockedBy: issue.blockedBy,
  body: issue.body,
  comments: issue.comments,
  number: issue.number,
  title: issue.title,
  url: issue.url,
});

export const serializeIssuePrompt = (issue: TrackerIssue) =>
  JSON.stringify(issuePromptValue(issue), null, 2);
