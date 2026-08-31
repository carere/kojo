import { Schema } from "effect";
import { RunId } from "../../shared/models/RunId.ts";

/**
 * One process's claim on one run.
 *
 * A run id names a branch, a branch names a worktree, and a worktree is a directory two processes
 * cannot both drive. So the claim is the thing a second process finds and refuses on — which means
 * it has to say **who** holds it and **since when**, not merely that somebody does. A refusal that
 * names nobody leaves a human with a lock file and no idea what to do about it.
 *
 * `holder` is whatever the runner calls itself. Kojo does not read a process id out of the runtime
 * for it: the entry point knows its own identity, the claim crosses to another machine as text, and
 * a number that only means something on the machine that wrote it is worse than a name.
 */
export class RunClaim extends Schema.Class<RunClaim>("RunClaim")({
  runId: RunId,
  holder: Schema.String,
  /** When the claim was taken, by the claiming process's clock. */
  since: Schema.Finite,
}) {}
