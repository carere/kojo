import { Schema } from "effect";

/**
 * The commit did not happen, and the workspace is as it was.
 *
 * Distinct from `WorkspaceError`, which means the workspace itself failed. Here git ran and
 * answered: the tree is on another branch, or there is nothing staged to commit. Both are faults of
 * the run rather than of the machine, and both leave everything in place to look at.
 *
 * It is its own error rather than a flavour of `NotAccepted` because it is not a judgement about
 * the work — nobody has judged anything yet. It says the proposal could not be written down.
 */
export class CommitRefused extends Schema.TaggedError<CommitRefused>()("CommitRefused", {
  /** The branch the run owns, which is the only branch a phase of that run may commit to. */
  branch: Schema.String,
  reason: Schema.String,
}) {}
