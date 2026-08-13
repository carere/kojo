import type { AskedGate } from "../../gate/models/AskedGate.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { RunLocked } from "../../workflow/models/RunLocked.ts";

/**
 * What a watcher has to say, as a value rather than as a printed line.
 *
 * A daemon that logged directly would be untestable in the only way that matters — *did it notice*
 * — so the watcher emits these and whoever runs it decides what they look like. The command line
 * renders them; a test collects them; a future Console reads them off a queue.
 *
 * Not a `Schema` class: nothing persists a notice. What is durable is the asking row, the trace and
 * the engine's own state, and a notice is the watcher saying it has read one of those.
 */
export type WatchNotice =
  /** An event became a run. The same run twice is two events and one id — that is the dedup. */
  | {
      readonly _tag: "started";
      readonly runId: RunId;
      readonly source: string;
      readonly key: string;
    }
  /** A run is waiting on a person, and this watcher has not said so before. */
  | { readonly _tag: "waiting"; readonly gate: AskedGate }
  /**
   * A run is waiting on a person **past the deadline** it declared.
   *
   * architecture.md §8 edge 8: a run nobody answered in time is the one nobody looked at, so it is
   * said out loud rather than left for whoever thinks to run `kojo gate list`.
   */
  | { readonly _tag: "overdue"; readonly gate: AskedGate }
  /** A run reached a terminal status. Said once per run, by whichever half of the watcher saw it. */
  | { readonly _tag: "ended"; readonly runId: RunId; readonly status: "succeeded" | "failed" }
  /** Another process is already driving this run, so this watcher did not (edge 9). */
  | { readonly _tag: "refused"; readonly locked: RunLocked };
