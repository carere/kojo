import { Cause, Context, Duration, Effect, Schema } from "effect";
import { Activity, DurableClock, type WorkflowEngine } from "effect/unstable/workflow";

export interface DurableBoundary {
  readonly details?: unknown;
  readonly idempotencyKey: string;
  readonly subject: string;
  readonly type: string;
}

interface DurableBoundaryRecorder {
  readonly record: (boundary: DurableBoundary) => Effect.Effect<void>;
}

const BoundaryRecorder = Context.Reference<DurableBoundaryRecorder>(
  "@kojo/workflow/DurableBoundaryRecorder",
  { defaultValue: () => ({ record: () => Effect.void }) },
);

const DurablePath = Context.Reference<ReadonlyArray<string>>("@kojo/workflow/DurablePath", {
  defaultValue: () => [],
});

const pathSubject = (path: ReadonlyArray<string>, leaf?: string) =>
  [...path, ...(leaf === undefined ? [] : [leaf])].join("/");

const stableName = (name: string) => name.length > 0 && name === name.trim();

const MaximumLimitReached = Schema.TaggedStruct("Loop.MaximumLimitReached", {
  name: Schema.String,
  maxIterations: Schema.Number,
});

export interface LoopIteration<A> {
  readonly iteration: number;
  readonly previous: A | undefined;
}

export interface LoopOptions<A, E, R> {
  readonly effect: (context: LoopIteration<A>) => Effect.Effect<A, E, R>;
  readonly maxIterations: number;
  readonly repeatWhile: (value: A) => boolean;
}

const runLoop = <A, E, R>(
  name: string,
  options: LoopOptions<A, E, R>,
): Effect.Effect<A, E | Schema.Schema.Type<typeof MaximumLimitReached>, R> =>
  Effect.gen(function* () {
    if (!stableName(name)) return yield* Effect.die("Loop.run requires a non-empty stable name");
    if (!Number.isSafeInteger(options.maxIterations) || options.maxIterations <= 0) {
      return yield* Effect.die("Loop.run requires a positive integer maxIterations");
    }
    const parentPath = yield* DurablePath;
    const recorder = yield* BoundaryRecorder;
    let previous: A | undefined;
    for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
      const path = [...parentPath, `${name}[${iteration}]`];
      const subject = pathSubject(path);
      yield* recorder.record({
        details: { iteration, maxIterations: options.maxIterations, name },
        idempotencyKey: `loop:${subject}:started`,
        subject,
        type: "Loop.IterationStarted",
      });
      const bodyExit = yield* Effect.exit(
        options.effect({ iteration, previous }).pipe(Effect.provideService(DurablePath, path)),
      );
      if (bodyExit._tag === "Failure") {
        yield* recorder.record({
          details: { iteration },
          idempotencyKey: `loop:${subject}:failed`,
          subject,
          type: "Loop.Failed",
        });
        return yield* Effect.failCause(bodyExit.cause);
      }
      const value = bodyExit.value;
      const repeat = options.repeatWhile(value);
      yield* recorder.record({
        details: { iteration, repeat },
        idempotencyKey: `loop:${subject}:decision`,
        subject,
        type: repeat ? "Loop.Repeated" : "Loop.Completed",
      });
      if (!repeat) return value;
      previous = value;
    }
    const failure = {
      _tag: "Loop.MaximumLimitReached" as const,
      maxIterations: options.maxIterations,
      name,
    };
    const subject = pathSubject(parentPath, name);
    yield* recorder.record({
      details: failure,
      idempotencyKey: `loop:${subject}:maximum-limit-reached`,
      subject,
      type: "Loop.MaximumLimitReached",
    });
    return yield* Effect.fail(failure);
  });

export interface ActivityRetryBackoffContext<E> {
  readonly failure: E;
  readonly ordinal: number;
}

export interface ActivityRetryOptions<E> {
  readonly backoff: Duration.Input | ((context: ActivityRetryBackoffContext<E>) => Duration.Input);
  readonly maxAttempts: number;
  readonly while: (failure: E) => boolean;
}

const retryActivity = <Success extends Schema.Constraint, Error extends Schema.Constraint, R>(
  activity: Activity.Activity<Success, Error, R>,
  options: ActivityRetryOptions<Error["Type"]>,
): Effect.Effect<
  Success["Type"],
  Error["Type"],
  | Success["DecodingServices"]
  | Error["DecodingServices"]
  | R
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0) {
      return yield* Effect.die("Activity Retry requires a positive integer maxAttempts");
    }
    const path = yield* DurablePath;
    const recorder = yield* BoundaryRecorder;
    const subject = pathSubject(path, activity.name);
    for (let ordinal = 1; ordinal <= options.maxAttempts; ordinal += 1) {
      const exit = yield* Effect.exit(
        activity.pipe(Effect.provideService(Activity.CurrentAttempt, ordinal)),
      );
      if (exit._tag === "Success") return exit.value;
      const failures = exit.cause.reasons.filter((reason) => reason._tag === "Fail");
      const failure = failures.length === 1 ? (failures[0]?.error as Error["Type"]) : undefined;
      if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause) || failure === undefined) {
        return yield* Effect.failCause(exit.cause);
      }
      if (ordinal === options.maxAttempts) {
        yield* recorder.record({
          details: { failure, maxAttempts: options.maxAttempts, ordinal },
          idempotencyKey: `activity-retry:${subject}:exhausted`,
          subject,
          type: "Activity.RetryExhausted",
        });
        return yield* Effect.failCause(exit.cause);
      }
      if (!options.while(failure)) {
        yield* recorder.record({
          details: { failure, ordinal },
          idempotencyKey: `activity-retry:${subject}:${ordinal}:declined`,
          subject,
          type: "Activity.RetryDeclined",
        });
        return yield* Effect.failCause(exit.cause);
      }
      const nextOrdinal = ordinal + 1;
      const backoff =
        typeof options.backoff === "function"
          ? options.backoff({ failure, ordinal: nextOrdinal })
          : options.backoff;
      yield* recorder.record({
        details: {
          backoff: Duration.toMillis(Duration.fromInputUnsafe(backoff)),
          failure,
          idempotencyKey: subject,
          ordinal: nextOrdinal,
        },
        idempotencyKey: `activity-retry:${subject}:${nextOrdinal}`,
        subject,
        type: "Activity.RetryScheduled",
      });
      yield* DurableClock.sleep({
        duration: backoff,
        inMemoryThreshold: "0 millis",
        name: `activity-retry:${subject}:${nextOrdinal}:backoff`,
      });
    }
    return yield* Effect.die("Activity Retry exhausted without a final result");
  }) as Effect.Effect<
    Success["Type"],
    Error["Type"],
    | Success["DecodingServices"]
    | Error["DecodingServices"]
    | R
    | WorkflowEngine.WorkflowEngine
    | WorkflowEngine.WorkflowInstance
  >;

export const Loop = Object.freeze({ MaximumLimitReached, run: runLoop });

export const ActivityRetry = Object.freeze({ run: retryActivity });

export const CompositionRuntime = Object.freeze({
  BoundaryRecorder,
  DurablePath,
  activitySubject: (activityName: string) =>
    DurablePath.pipe(Effect.map((path) => pathSubject(path, activityName))),
});
