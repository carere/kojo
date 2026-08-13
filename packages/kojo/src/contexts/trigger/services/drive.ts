import { Duration, Effect, Schedule, type Schema, Stream } from "effect";
import type { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { decodeUnknown } from "../../shared/lib/decode.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { RunOutcome } from "../../trace/models/RunRecord.ts";
import { start, status } from "../../workflow/services/run.ts";
import { TriggerError } from "../models/TriggerError.ts";
import type { TriggerEvent } from "../models/TriggerEvent.ts";
import { Trigger } from "../ports/Trigger.ts";

/** Everything a run needs beyond the engine itself, gathered once so three signatures stay short. */
type RunServices<
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
> =
  | WorkflowEngine.WorkflowEngine
  | Payload["DecodingServices"]
  | Payload["EncodingServices"]
  | Success["DecodingServices"]
  | Error["DecodingServices"];

/**
 * How often a driven run is asked where it got to.
 *
 * Slow on purpose. A run reaches its first suspension in milliseconds or in an hour, and neither the
 * ticket nor the webhook is waiting on this number — it decides how promptly an *acknowledgement* is
 * written, not how promptly work starts.
 */
const defaultPoll = Duration.seconds(1);

/**
 * The event's payload, decoded, having agreed with the workflow about what it is deduplicated by.
 *
 * The key check is the whole reason this is not one line. The trigger states the dedup value on the
 * event; the engine derives the execution id from the workflow's own `idempotencyKey`. If those two
 * disagree, everything still *works* — and a ticket triggered twice quietly opens two factories,
 * which is the exact failure this port exists to prevent. So they are compared, once, before the run
 * starts, and a disagreement is a named error rather than a second branch nobody asked for.
 */
const payloadOf = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  event: TriggerEvent,
): Effect.Effect<Payload["Type"], TriggerError, Payload["DecodingServices"]> =>
  decodeUnknown(definition.payloadSchema)(event.payload).pipe(
    Effect.mapError((error) =>
      TriggerError.fromSchemaError({ source: event.source, key: event.key }, error),
    ),
    Effect.flatMap((payload) => {
      const deduplicatedBy = definition.idempotencyKey(payload);
      return deduplicatedBy === event.key
        ? Effect.succeed(payload)
        : Effect.fail(
            new TriggerError({
              source: event.source,
              fault: "key-mismatch",
              key: event.key,
              reason: `the workflow deduplicates this payload by "${deduplicatedBy}"`,
              issues: [],
              cause: undefined,
            }),
          );
    }),
  );

/**
 * Starts the run one event asks for, and returns its id immediately.
 *
 * Deduplication happens here and nowhere else: the engine hashes the workflow tag and the
 * idempotency key into the execution id, so a second event for one ticket revision resolves to the
 * run that already exists. Nothing in Kojo keeps a table of seen events beside it.
 */
export const runFor = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  event: TriggerEvent,
): Effect.Effect<RunId, TriggerError, RunServices<Payload, Success, Error>> =>
  Effect.flatMap(payloadOf(definition, event), (payload) =>
    // A decoded payload is a valid constructor input by construction — the constructor's input type
    // differs only where a field has a decoding default, and a decoded value has that field filled.
    start(definition, payload as Payload["~type.make.in"]),
  );

/**
 * Where the run stopped, waiting only as long as it has to.
 *
 * Polling rather than joining, because joining is the trap `run.ts` documents: the engine's own
 * `execute` returns only on `Complete`, so a driver that awaited it would sit on a run that suspended
 * at a two-day gate for two days. `suspended` is a settled answer here — the run let go of everything
 * it held, and the source deserves to hear so.
 *
 * The wait is a `Schedule`, so it runs on the Effect `Clock` and a test drives it with `TestClock`
 * rather than with a real second.
 */
const settled = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  runId: RunId,
  poll: Duration.Input,
): Effect.Effect<
  RunOutcome,
  never,
  WorkflowEngine.WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  Effect.repeat(status(definition, runId), {
    schedule: Schedule.spaced(poll),
    until: (current): current is RunOutcome => current !== "running",
  });

/**
 * Turns a trigger's events into runs, one at a time, for as long as the source has events.
 *
 * One event at a time on purpose. A source hands out work in the order it thinks matters, and
 * acknowledging out of order is how a tracker ends up with the wrong ticket closed. A factory that
 * wants two runs in flight says so with two lanes inside one workflow, where the trace can see them.
 *
 * A fault ends the drive rather than skipping the event, and that is deliberate too: `malformed` and
 * `key-mismatch` are a mistake in the factory itself, and a watcher that swallowed them would sit
 * there looking healthy while every event fell on the floor.
 */
export const drive = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  options?: { readonly poll?: Duration.Input | undefined },
): Effect.Effect<void, TriggerError, Trigger | RunServices<Payload, Success, Error>> =>
  Effect.flatMap(Trigger, (trigger) =>
    trigger.stream.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const runId = yield* runFor(definition, event);
          const outcome = yield* settled(definition, runId, options?.poll ?? defaultPoll);
          yield* trigger.ack(event, { runId, outcome });
        }),
      ),
    ),
  );
