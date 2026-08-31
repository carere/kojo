import { Clock, Context, type Duration, Effect, Layer, Stream } from "effect";
import { TriggerEvent } from "../models/TriggerEvent.ts";
import { Trigger, type TriggerOutcome } from "../ports/Trigger.ts";

/** One event a test says arrives, and when it arrives. */
export interface ProgrammedEvent {
  readonly key: string;
  readonly payload: unknown;
  /** Which source it claims to be from. Defaults to `in-memory`. */
  readonly source?: string | undefined;
  /**
   * How long after the previous event this one arrives. Absent means immediately.
   *
   * This is what lets one adapter stand in for all four shapes: no delay is the manual and webhook
   * case, an equal delay on every event is a poller, an uneven one is a cron. It is a `Clock` sleep,
   * so `TestClock` moves it and no test waits on a real second.
   */
  readonly after?: Duration.Input | undefined;
}

/** One event, and what the run it started came to. */
export interface Acknowledgement {
  readonly event: TriggerEvent;
  readonly run: TriggerOutcome;
}

/**
 * What was acknowledged, readable from a test without a tracker.
 *
 * Separate from `Trigger` for the same reason `RecordedTrace` is separate from `Tracer`: nothing
 * that produces work should be able to read back what every other source was told.
 */
export class AcknowledgedEvents extends Context.Service<
  AcknowledgedEvents,
  { readonly acks: Effect.Effect<ReadonlyArray<Acknowledgement>> }
>()("kojo/trigger/AcknowledgedEvents") {}

/**
 * A source written before the run started, and an acknowledgement nobody has to go and read.
 *
 * This is the adapter that makes a whole factory testable from its beginning rather than from its
 * first phase: a test says two events arrive naming the same ticket revision, and asserts one run
 * came out. No tracker, no webhook endpoint, no clock but the virtual one.
 *
 * Both services come out of one `Layer.effectContext` because they are two views of the same array.
 * Two layers would each build their own, and the reader would always be empty — a failure that looks
 * exactly like "nothing was acknowledged".
 */
/** @public */
export const layer = (
  events: ReadonlyArray<ProgrammedEvent>,
): Layer.Layer<AcknowledgedEvents | Trigger> =>
  Layer.effectContext(
    Effect.sync(() => {
      const acks: Array<Acknowledgement> = [];

      const stream = Stream.fromArray(events).pipe(
        Stream.mapEffect((programmed) =>
          Effect.gen(function* () {
            if (programmed.after !== undefined) yield* Effect.sleep(programmed.after);
            return new TriggerEvent({
              source: programmed.source ?? "in-memory",
              key: programmed.key,
              payload: programmed.payload,
              // Read when the event is pulled, so an event scheduled an hour out is stamped an hour
              // out rather than at the moment the layer was built.
              receivedAt: yield* Clock.currentTimeMillis,
            });
          }),
        ),
      );

      return Context.make(Trigger, {
        stream,
        ack: (event, run) => Effect.sync(() => void acks.push({ event, run })),
      }).pipe(Context.add(AcknowledgedEvents, { acks: Effect.sync(() => [...acks]) }));
    }),
  );
