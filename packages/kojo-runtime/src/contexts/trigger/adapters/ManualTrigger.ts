import { Clock, Console, Effect, Layer, Stream } from "effect";
import { TriggerEvent } from "../models/TriggerEvent.ts";
import { Trigger, type TriggerOutcome } from "../ports/Trigger.ts";

/** What a person supplies: the unit of work, and the value it is deduplicated by. */
export interface ManualEvent {
  /**
   * What the run is deduplicated by. Must be what the workflow's `idempotencyKey` returns.
   *
   * Typing the command twice is the commonest way a factory is triggered twice, so the manual
   * adapter is the first place the key earns its keep, not an afterthought for the poller.
   */
  readonly key: string;
  /** The payload the run starts from, as the person wrote it — decoded when the run starts. */
  readonly payload: unknown;
}

const describe = (event: TriggerEvent, run: TriggerOutcome): string =>
  `${event.source} ${event.key} → run ${run.runId} ${run.outcome}`;

/**
 * A person, at a terminal. The reference adapter: one event, then the stream ends.
 *
 * Ending is the behaviour, not a limitation. `kojo run` is one unit of work and the process should
 * exit when it has been dealt with; a daemon's source is a stream that never ends, and the driver
 * that consumes both is the same code. That is the claim the `Stream` shape makes, and this adapter
 * is one end of the evidence for it.
 *
 * `receivedAt` is read from the `Clock` at the moment the event is pulled, not when the layer is
 * built, so nothing here reads a wall clock a test cannot move.
 *
 * Acknowledging prints one line and returns. There is no ticket to close and no webhook to answer —
 * the person is standing there — so the honest ack is to tell them where the run stopped, including
 * when it stopped at `suspended`, which is the case a silent adapter would leave looking like a hang.
 */
/** @public */
export const layer = (event: ManualEvent): Layer.Layer<Trigger> =>
  Layer.succeed(Trigger)({
    stream: Stream.fromArrayEffect(
      Effect.map(Clock.currentTimeMillis, (receivedAt) => [
        new TriggerEvent({
          source: "manual",
          key: event.key,
          payload: event.payload,
          receivedAt,
        }),
      ]),
    ),
    ack: (acked, run) => Console.log(describe(acked, run)),
  });
