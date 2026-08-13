import { Context, type Effect, type Scope } from "effect";
import type { RunId } from "../../shared/models/RunId.ts";
import type { RunClaim } from "../models/RunClaim.ts";
import type { RunLocked } from "../models/RunLocked.ts";

/**
 * Who is allowed to drive a run right now.
 *
 * One method, and it is scoped on purpose: a claim that is not tied to a scope is a claim somebody
 * has to remember to give back, and the process that forgets is the process that already crashed.
 * `Effect.scoped` releases it on every exit path — success, failure, interrupt — which is the same
 * discipline the sandbox scope uses for the container.
 *
 * **A claim is refused, never queued.** There is no `waitFor`, and the absence is the design: two
 * runners against one run id contend for one worktree, and a queue would turn that corruption into
 * a delay somebody eventually stops noticing. The port therefore cannot express waiting.
 *
 * The reference adapter is a file beside the run's data, because that is what survives a process
 * dying and is readable by a human holding nothing but a shell. A lease row in the trace database
 * and a lock service on a cluster are the obvious others, and neither changes this interface.
 */
export class RunLock extends Context.Service<
  RunLock,
  {
    readonly claim: (runId: RunId) => Effect.Effect<RunClaim, RunLocked, Scope.Scope>;
  }
>()("kojo/workflow/RunLock") {}
