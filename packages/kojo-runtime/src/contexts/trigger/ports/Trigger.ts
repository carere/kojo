import { Context, type Effect, type Stream } from "effect";
import type { RunId } from "../../shared/models/RunId.ts";
import type { TriggerError } from "../models/TriggerError.ts";
import type { TriggerEvent } from "../models/TriggerEvent.ts";

/** The Run that the Daemon admitted for one Trigger event. */
export interface TriggerOutcome {
  readonly runId: RunId;
  /** The Daemon committed the Run before it asked the source to acknowledge. */
  readonly outcome: "admitted";
}

interface TriggerService {
  /** One event per unit of work. A live Daemon source normally does not end. */
  readonly stream: Stream.Stream<TriggerEvent, TriggerError>;
  readonly ack: (event: TriggerEvent, run: TriggerOutcome) => Effect.Effect<void, TriggerError>;
}

const TriggerBase: Context.ServiceClass<Trigger, "kojo/trigger/Trigger", TriggerService> =
  Context.Service<Trigger, TriggerService>()("kojo/trigger/Trigger");

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
 * `ack` confirms admission after the Daemon commits the Run. It does not report Run completion
 * or a Gate suspension. The source can use the Run id to link to later Run status.
 */
export class Trigger extends TriggerBase {}
