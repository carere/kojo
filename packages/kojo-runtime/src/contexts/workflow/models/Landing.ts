import { Schema } from "effect";

/** What the merge produced: the accepted branch, where it landed, and the commit that landed it. */
export class Landing extends Schema.Class<Landing>("Landing")({
  branch: Schema.String,
  into: Schema.String,
  /** The merge commit, read back from the target rather than assumed to exist. */
  sha: Schema.String,
}) {}
