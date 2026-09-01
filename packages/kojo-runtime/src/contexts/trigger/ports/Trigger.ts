import { Context, type Effect, type Stream } from "effect";
import type { RunId } from "../../shared/models/RunId.ts";
import type { TriggerError } from "../models/TriggerError.ts";
import type { TriggerEvent } from "../models/TriggerEvent.ts";

/**
 * What one event produced: the run, and where that run stopped.
 *
 * `suspended` is a perfectly good thing to acknowledge — it says a human was asked and the factory
 * let go of everything it held. A tracker comment that says "waiting on review, run `<id>`" is more
 * use than silence until Tuesday, so the run id travels with the outcome rather than only the word.
 */
export interface TriggerOutcome {
  readonly runId: RunId;
  /** The Daemon committed the Run before it asked the source to acknowledge. */
  readonly outcome: "admitted";
}

/**
 * What starts a run, and what that run is deduplicated by.
 *
 * A `Stream` rather than four interfaces, because the four shapes differ only in when the next event
 * arrives: the **manual** adapter emits one event and ends, a **poller** emits on an interval, a
 * **webhook receiver** emits on request, a **cron** emits on schedule. Every one of them is a
 * `Stream<TriggerEvent>`, so the Daemon Runner handles them through one port.
 *
 * The port does **not** deduplicate. Every event carries the value the run is deduplicated by, and
 * the dedup itself is the workflow's own `idempotencyKey` — the engine hashes it into the execution
 * id, so a second event for one ticket revision finds the first run. A second mechanism beside that
 * one would be a second answer to "is this the same unit of work", and two answers means neither is
 * trustworthy.
 *
 * `ack` is the other half of a trigger, and the reason a trigger is a port at all: it is where a
 * ticket gets closed, a webhook gets its response, a queue message gets deleted. It runs after the
 * run settles, and it takes the event and the run outcome — nothing else, because an adapter that
 * needed the workflow's internals would be a workflow, not a source of work.
 */
export class Trigger extends Context.Service<
  Trigger,
  {
    /** One event per unit of work. A live Daemon source normally does not end. */
    readonly stream: Stream.Stream<TriggerEvent, TriggerError>;
    readonly ack: (event: TriggerEvent, run: TriggerOutcome) => Effect.Effect<void, TriggerError>;
  }
>()("kojo/trigger/Trigger") {}
