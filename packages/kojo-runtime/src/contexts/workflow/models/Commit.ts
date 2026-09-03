import { Schema } from "effect";

/**
 * What a commit phase left on the run's branch.
 *
 * The message is carried back because the agent proposed it and code performed it: the record of
 * what was written is the phase's, not the agent's word for it. `files` is what git staged, read
 * from the index rather than from the envelope — an agent's claim about which files it changed is
 * a claim, and `diffMatchesClaims` is the check that grades it.
 */
export class Commit extends Schema.Class<Commit>("Commit")({
  branch: Schema.String,
  /** The full object name of the commit, as `git rev-parse HEAD` reports it. */
  sha: Schema.String,
  message: Schema.String,
  files: Schema.Array(Schema.String),
}) {}
