import { Schema } from "effect";

/**
 * What became of one unauthorised change.
 *
 * Detection alone would leave the repository holding the change while the trace reports a failure,
 * so every breached path is undone before the phase dies. Undoing is not always possible, and the
 * outcomes below are the honest answers rather than a boolean that hides three different stories.
 *
 * `WorkLost` is the one that must never be silent. A path that was dirty before the agent ran and
 * is clean afterwards means the agent discarded somebody's uncommitted work — `git checkout` inside
 * a shell is exactly how that happens — and the content is not ours to reconstruct.
 */
export const RollbackOutcome: Schema.TaggedUnion<{
  readonly Deleted: Schema.TaggedStruct<"Deleted", Record<never, never>>;
  readonly LeftAsIs: Schema.TaggedStruct<"LeftAsIs", Record<never, never>>;
  readonly NotUndone: Schema.TaggedStruct<
    "NotUndone",
    {
      readonly reason: Schema.String;
    }
  >;
  readonly Restored: Schema.TaggedStruct<"Restored", Record<never, never>>;
  readonly WorkLost: Schema.TaggedStruct<"WorkLost", Record<never, never>>;
}> = Schema.TaggedUnion({
  /** The agent created the file, and it is gone again. */
  Deleted: {},
  /** The agent edited a tracked file, and the tree holds what `HEAD` holds again. */
  Restored: {},
  /**
   * The path was already dirty when the agent started, so the change is not all the agent's.
   * Discarding it to tidy up would be the same harm this guard exists to prevent, committed by
   * the cleanup instead of by the agent.
   */
  LeftAsIs: {},
  /** Uncommitted work the agent reverted. Nothing can restore it; naming it is all we can do. */
  WorkLost: {},
  /** The undo itself failed. `reason` is what the workspace said. */
  NotUndone: { reason: Schema.String },
});
export type RollbackOutcome = typeof RollbackOutcome.Type;

const PathRollbackBase: Schema.Class<
  PathRollback,
  Schema.Struct<{
    readonly path: Schema.String;
    readonly outcome: Schema.TaggedUnion<{
      readonly Deleted: Schema.TaggedStruct<"Deleted", Record<never, never>>;
      readonly LeftAsIs: Schema.TaggedStruct<"LeftAsIs", Record<never, never>>;
      readonly NotUndone: Schema.TaggedStruct<
        "NotUndone",
        {
          readonly reason: Schema.String;
        }
      >;
      readonly Restored: Schema.TaggedStruct<"Restored", Record<never, never>>;
      readonly WorkLost: Schema.TaggedStruct<"WorkLost", Record<never, never>>;
    }>;
  }>,
  Record<never, never>
> = Schema.Class<PathRollback>("PathRollback")({
  path: Schema.String,
  outcome: RollbackOutcome,
});

/**
 * One breached path and what became of it.
 *
 * Both the error and the phase record carry these, because the two answer different questions —
 * *why did this phase die* and *what did this run leave behind* — from the same fact.
 */
export class PathRollback extends PathRollbackBase {}
