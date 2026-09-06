import { Schema } from "effect";

const CommitBase: Schema.Class<
  Commit,
  Schema.Struct<{
    readonly branch: Schema.String;
    readonly sha: Schema.String;
    readonly message: Schema.String;
    readonly files: Schema.$Array<Schema.String>;
  }>,
  Record<never, never>
> = Schema.Class<Commit>("Commit")({
  branch: Schema.String,
  /** The full object name of the commit, as `git rev-parse HEAD` reports it. */
  sha: Schema.String,
  message: Schema.String,
  files: Schema.Array(Schema.String),
});

/**
 * What a commit phase left on the run's branch.
 *
 * The message is carried back because the agent proposed it and code performed it: the record of
 * what was written is the phase's, not the agent's word for it. `files` is what git staged, read
 * from the index rather than from the envelope — an agent's claim about which files it changed is
 * a claim, and `diffMatchesClaims` is the check that grades it.
 */
export class Commit extends CommitBase {}
