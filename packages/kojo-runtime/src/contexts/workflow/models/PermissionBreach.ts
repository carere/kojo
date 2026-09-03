import { Schema } from "effect";
import { PathRollback } from "../../shared/models/PathRollback.ts";

/**
 * An agent changed a path it was not permitted to change.
 *
 * **This is deliberately not a member of the correction loop's handled tags.** A parse error or a
 * check violation is work an agent can be asked to redo; a breach cannot be corrected by
 * re-prompting, because the write already happened and has already been undone. Retrying one is
 * meaningless, and the design makes it impossible rather than merely discouraged: `catchTags` over
 * the loop's own tags leaves this error in the residual channel, and adding a handler for it to an
 * effect that cannot raise it is a compile error. See architecture.md D8.
 *
 * `scope` is the agent's permission in words, so the trace explains the refusal without holding the
 * policy. `paths` carries the rollback outcome beside each path, because "unauthorised change
 * reverted" and "unauthorised change we could not revert" are different facts about the repository.
 */
export class PermissionBreach extends Schema.TaggedError<PermissionBreach>()("PermissionBreach", {
  agent: Schema.String,
  scope: Schema.String,
  paths: Schema.Array(PathRollback),
}) {}
