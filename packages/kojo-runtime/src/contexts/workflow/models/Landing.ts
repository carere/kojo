import { Schema } from "effect";

const LandingBase: Schema.Class<
  Landing,
  Schema.Struct<{
    readonly branch: Schema.String;
    readonly into: Schema.String;
    readonly sha: Schema.String;
  }>,
  Record<never, never>
> = Schema.Class<Landing>("Landing")({
  branch: Schema.String,
  into: Schema.String,
  /** The merge commit, read back from the target rather than assumed to exist. */
  sha: Schema.String,
});

/** What the merge produced: the accepted branch, where it landed, and the commit that landed it. */
export class Landing extends LandingBase {}
