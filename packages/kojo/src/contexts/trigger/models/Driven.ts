import type { Effect } from "effect";
import type { WorkflowEngine } from "effect/unstable/workflow";
import type { RunId } from "../../shared/models/RunId.ts";
import type { RunStatus } from "../../workflow/services/run.ts";
import type { TriggerError } from "./TriggerError.ts";
import type { TriggerEvent } from "./TriggerEvent.ts";

/**
 * One workflow a watcher can ask about, with its generic parameters erased.
 *
 * The same erasure `Runnable` makes for the command line, and for the same reason: a
 * `Workflow.Workflow<Tag, Payload, Success, Error>` differs in four type parameters per workflow, so
 * a **list** of them has nothing usable in common. A watcher holds such a list because a suspended
 * run it has never seen may belong to any workflow this build registers — the token says which —
 * and asking that run where it got to must not need the run's payload type.
 */
export interface Watched {
  readonly name: string;
  readonly status: (runId: RunId) => Effect.Effect<RunStatus, never, WorkflowEngine.WorkflowEngine>;
}

/**
 * The workflow a watcher's events start, which is one of the ones it watches.
 *
 * `driven` is `runFor` with the definition already bound: it decodes the event against the
 * workflow's payload schema, checks the event and the workflow agree about what the run is
 * deduplicated by, and starts it. Two events naming one ticket revision therefore resolve to one
 * run here rather than in anything the watcher adds.
 */
export interface Driven extends Watched {
  readonly driven: (
    event: TriggerEvent,
  ) => Effect.Effect<RunId, TriggerError, WorkflowEngine.WorkflowEngine>;
}
