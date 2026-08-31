import { Schema } from "effect";

/**
 * What a phase did to the repository, in the phase's own row.
 *
 * The three lists answer one question a factory asks constantly and a diff cannot: *did the answer
 * describe the work?* `claimed` is what the envelope said, `changed` is what the working tree
 * actually held afterwards, and the pair is what makes an agent that reported work it did not do
 * visible after the run rather than during the review.
 *
 * The permitted half only. Everything an agent changed **without** permission is on `breaches`
 * beside this, with what became of each path — two fields because they answer two questions, and
 * because a run where they disagree is exactly the run somebody is investigating.
 */
export class RepoEffect extends Schema.Class<RepoEffect>("RepoEffect")({
  /** The paths the envelope claimed. Empty when the phase's answer claims nothing. */
  claimed: Schema.Array(Schema.String),
  /**
   * The paths the working tree actually changed, as `withPermissions` returns them.
   *
   * "Changed" means one thing in this codebase — appeared, vanished, or was rewritten relative to
   * `HEAD` — because it comes from the same fingerprint the permission guard takes.
   */
  changed: Schema.Array(Schema.String),
  /** The commits the phase produced, newest first. Empty when it committed nothing. */
  commits: Schema.Array(Schema.String),
}) {}
