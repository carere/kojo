import { Schema } from "effect";

/**
 * The merge ran and did not land, and the target is exactly as it was.
 *
 * A conflict is the ordinary case, and it is not a `WorkspaceError`: git did its job and reported
 * that two histories disagree. The other cases are the same shape — the target is not the branch it
 * was said to be, or it holds uncommitted work — and they are refusals rather than faults for the
 * same reason.
 *
 * **Whatever the reason, nothing is left half-merged.** A conflicted merge is aborted before this
 * error is raised, so the inspection surface a rejected run leaves is a target nobody has to
 * unpick.
 */
export class MergeRefused extends Schema.TaggedError<MergeRefused>()("MergeRefused", {
  branch: Schema.String,
  into: Schema.String,
  reason: Schema.String,
}) {}
