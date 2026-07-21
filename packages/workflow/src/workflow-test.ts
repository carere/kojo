import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Equal,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect";
import { Workflow as EffectWorkflow, WorkflowEngine } from "effect/unstable/workflow";
import type { WorkflowDefinition } from "./index";

export namespace WorkflowTest {
  export type ExternalLayer = "Agent" | "Sandbox" | "Command" | "Git" | "GitHub";

  export interface CallMatcher {
    readonly input?: unknown;
    readonly layer: ExternalLayer;
    readonly operation: string;
  }

  export interface Call extends CallMatcher {
    readonly attempt: number;
    readonly ordinal: number;
    readonly status: "Completed" | "Failed" | "Uncertain";
  }

  export interface EvidenceEvent {
    readonly attempt: number;
    readonly details?: unknown;
    readonly eventId: string;
    readonly recordedAt: string;
    readonly sequence: number;
    readonly subject: string;
    readonly type: string;
  }

  export interface TraceSpan {
    readonly attempt: number;
    readonly outcome?: string;
    readonly sequence: number;
    readonly subject: string;
    readonly type: "Activity" | "DurableClock" | "ExternalCall" | "WorkflowRun";
  }

  export type Outcome<Success, Failure> =
    | { readonly _tag: "Success"; readonly value: Success }
    | { readonly _tag: "Failure"; readonly failure: Failure }
    | { readonly _tag: "Defect"; readonly cause: string }
    | { readonly _tag: "Interrupted" };

  export interface Result<Success, Failure> {
    readonly attempt: number;
    readonly calls: ReadonlyArray<Call>;
    readonly evidence: ReadonlyArray<EvidenceEvent>;
    readonly outcome: Outcome<Success, Failure>;
    readonly runId: string;
    readonly state: "Completed" | "Failed" | "Interrupted";
    readonly trace: ReadonlyArray<TraceSpan>;
  }

  export interface RunOptions {
    readonly interruptAfter?: {
      readonly subject?: string;
      readonly type: string;
    };
    readonly uncertain?: ReadonlyArray<CallMatcher>;
  }

  export interface MakeOptions<Requirements> {
    readonly clock?: Date | number | string;
    readonly ids?: Iterable<string>;
    readonly layer?: Layer.Layer<Requirements, never, never>;
  }

  export interface Fixture<Input, Success, Failure> {
    readonly restart: () => Promise<Result<Success, Failure>>;
    readonly run: (input: Input, options?: RunOptions) => Promise<Result<Success, Failure>>;
  }

  export interface NormalizeOptions {
    readonly ignore?: ReadonlyArray<string>;
    readonly ids?: boolean;
    readonly timestamps?: boolean;
  }
}

interface RecorderService {
  readonly call: <A, E, R>(
    matcher: WorkflowTest.CallMatcher,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly nextId: Effect.Effect<string>;
}

const Recorder = Context.Service<RecorderService>("@kojo/workflow/WorkflowTest/Recorder");

class InterruptedSignal extends Error {}
class UncertainSignal extends Error {}

const matchesCall = (call: WorkflowTest.CallMatcher, matcher: WorkflowTest.CallMatcher) =>
  call.layer === matcher.layer &&
  call.operation === matcher.operation &&
  (matcher.input === undefined || Equal.equals(call.input, matcher.input));

const spanIdentity = (event: WorkflowTest.EvidenceEvent, type: WorkflowTest.TraceSpan["type"]) => {
  const details =
    typeof event.details === "object" && event.details !== null
      ? (event.details as Record<string, unknown>)
      : undefined;
  const ordinal =
    type === "ExternalCall"
      ? details?.ordinal
      : type === "Activity"
        ? details?.activityAttempt
        : undefined;
  return `${type}:${event.attempt}:${event.subject}:${String(ordinal ?? "")}`;
};

const traceFromEvidence = (
  workflowName: string,
  evidence: ReadonlyArray<WorkflowTest.EvidenceEvent>,
): ReadonlyArray<WorkflowTest.TraceSpan> => {
  const first = evidence[0];
  const terminal = evidence.findLast(({ type }) =>
    ["WorkflowRun.Completed", "WorkflowRun.Failed", "WorkflowRun.Interrupted"].includes(type),
  );
  const spans: Array<WorkflowTest.TraceSpan> = [
    {
      attempt: first?.attempt ?? 1,
      outcome: terminal?.type.slice("WorkflowRun.".length),
      sequence: first?.sequence ?? 1,
      subject: workflowName,
      type: "WorkflowRun",
    },
  ];
  const seen = new Set<string>();
  for (const event of evidence) {
    const type = event.type.endsWith(".Replayed")
      ? undefined
      : event.type.startsWith("ExternalCall.")
        ? "ExternalCall"
        : event.type.startsWith("Activity.")
          ? "Activity"
          : event.type === "DurableClock.Scheduled"
            ? "DurableClock"
            : undefined;
    if (type === undefined) continue;
    const key = spanIdentity(event, type);
    if (seen.has(key)) continue;
    seen.add(key);
    const finished = evidence.findLast(
      (candidate) =>
        candidate.attempt === event.attempt &&
        candidate.subject === event.subject &&
        candidate.type.startsWith(`${type}.`) &&
        spanIdentity(candidate, type) === key,
    );
    spans.push({
      attempt: event.attempt,
      outcome: finished?.type.slice(type.length + 1),
      sequence: event.sequence,
      subject: event.subject,
      type,
    });
  }
  return spans;
};

const make = <
  const Name extends string,
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Requirements,
>(
  workflow: WorkflowDefinition<Name, Input, Success, Failure, Requirements>,
  makeOptions: WorkflowTest.MakeOptions<Requirements> = {},
): WorkflowTest.Fixture<
  Schema.Schema.Type<Input>,
  Schema.Schema.Type<Success>,
  Schema.Schema.Type<Failure>
> => {
  type SuccessValue = Schema.Schema.Type<Success>;
  type FailureValue = Schema.Schema.Type<Failure>;

  const runId = "run-1";
  const evidence: Array<WorkflowTest.EvidenceEvent> = [];
  const calls: Array<WorkflowTest.Call> = [];
  const activityJournal = new Map<string, EffectWorkflow.Result<unknown, unknown>>();
  const callJournal = new Map<
    string,
    { readonly exit?: Exit.Exit<unknown, unknown>; readonly uncertain: boolean }
  >();
  const ids = [...(makeOptions.ids ?? [])];
  let generatedId = 0;
  let attempt = 0;
  let currentTime =
    makeOptions.clock === undefined
      ? Date.parse("2000-01-01T00:00:00.000Z")
      : typeof makeOptions.clock === "number"
        ? makeOptions.clock
        : new Date(makeOptions.clock).getTime();
  let latestInput: Schema.Schema.Type<Input> | undefined;
  let hasRun = false;
  let latestResult: WorkflowTest.Result<SuccessValue, FailureValue> | undefined;

  const clock: Clock.Clock = {
    currentTimeMillis: Effect.sync(() => currentTime),
    currentTimeMillisUnsafe: () => currentTime,
    currentTimeNanos: Effect.sync(() => BigInt(currentTime) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(currentTime) * 1_000_000n,
    sleep: (duration) =>
      Effect.sync(() => {
        currentTime += Duration.toMillis(duration);
      }),
  };

  const execute = async (
    input: Schema.Schema.Type<Input>,
    runOptions: WorkflowTest.RunOptions = {},
  ): Promise<WorkflowTest.Result<SuccessValue, FailureValue>> => {
    attempt += 1;
    const callOrdinals = new Map<string, number>();
    let interrupted = false;
    let interruptionConsumed = false;

    const append = (type: string, subject: string, details?: unknown) => {
      const event: WorkflowTest.EvidenceEvent = Object.freeze({
        attempt,
        ...(details === undefined ? {} : { details }),
        eventId: `event-${evidence.length + 1}`,
        recordedAt: new Date(currentTime).toISOString(),
        sequence: evidence.length + 1,
        subject,
        type,
      });
      evidence.push(event);
      if (
        !interruptionConsumed &&
        runOptions.interruptAfter?.type === type &&
        (runOptions.interruptAfter.subject === undefined ||
          runOptions.interruptAfter.subject === subject)
      ) {
        interruptionConsumed = true;
        interrupted = true;
        throw new InterruptedSignal();
      }
      return event;
    };

    const recorder: RecorderService = {
      call: (matcher, effect) =>
        Effect.gen(function* () {
          const ordinalKey = `${matcher.layer}.${matcher.operation}`;
          const ordinal = (callOrdinals.get(ordinalKey) ?? 0) + 1;
          callOrdinals.set(ordinalKey, ordinal);
          const journalKey = `${ordinalKey}:${ordinal}`;
          const stored = callJournal.get(journalKey);
          const subject = `${matcher.layer}.${matcher.operation}`;
          if (stored?.uncertain === true) {
            interrupted = true;
            append("ExternalCall.Uncertain", subject, { input: matcher.input, ordinal });
            return yield* Effect.die(new UncertainSignal());
          }
          if (stored?.exit !== undefined) {
            append("ExternalCall.Replayed", subject, { input: matcher.input, ordinal });
            if (Exit.isSuccess(stored.exit)) return stored.exit.value as never;
            return yield* Effect.failCause(stored.exit.cause as Cause.Cause<never>);
          }

          append("ExternalCall.Started", subject, { input: matcher.input, ordinal });
          const callRecord: WorkflowTest.Call = {
            attempt,
            input: matcher.input,
            layer: matcher.layer,
            operation: matcher.operation,
            ordinal,
            status: "Completed",
          };
          calls.push(callRecord);
          const exit = yield* Effect.exit(effect);
          const uncertain = runOptions.uncertain?.some((candidate) =>
            matchesCall(matcher, candidate),
          );
          if (uncertain === true) {
            calls[calls.length - 1] = { ...callRecord, status: "Uncertain" };
            callJournal.set(journalKey, { uncertain: true });
            append("ExternalCall.Uncertain", subject, { input: matcher.input, ordinal });
            interrupted = true;
            return yield* Effect.die(new UncertainSignal());
          }
          callJournal.set(journalKey, { exit, uncertain: false });
          if (Exit.isSuccess(exit)) {
            append("ExternalCall.Completed", subject, { ordinal, output: exit.value });
            return exit.value;
          }
          calls[calls.length - 1] = { ...callRecord, status: "Failed" };
          append("ExternalCall.Failed", subject, { ordinal });
          return yield* Effect.failCause(exit.cause);
        }),
      nextId: Effect.sync(() => ids.shift() ?? `id-${++generatedId}`),
    };

    const engineLayer = Layer.effect(
      WorkflowEngine.WorkflowEngine,
      Effect.sync(() => {
        const workflows = new Map<
          string,
          (payload: object, executionId: string) => Effect.Effect<unknown, unknown, unknown>
        >();
        const deferredJournal = new Map<string, Exit.Exit<unknown, unknown>>();
        let engine: WorkflowEngine.WorkflowEngine["Service"];
        engine = WorkflowEngine.makeUnsafe({
          activityExecute: (activity, activityAttempt) =>
            Effect.gen(function* () {
              const parent = yield* WorkflowEngine.WorkflowInstance;
              const key = `${parent.executionId}:${activity.name}:${activityAttempt}`;
              const stored = activityJournal.get(key);
              if (stored !== undefined) {
                append("Activity.Replayed", activity.name, { activityAttempt });
                return stored;
              }
              append("Activity.Started", activity.name, { activityAttempt });
              const instance = WorkflowEngine.WorkflowInstance.initial(
                parent.workflow,
                parent.executionId,
              );
              const result = yield* activity.executeEncoded.pipe(
                EffectWorkflow.intoResult,
                Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
                Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
              );
              activityJournal.set(key, result);
              const activityOutcome =
                result._tag === "Suspended"
                  ? "Suspended"
                  : Exit.isSuccess(result.exit)
                    ? "Completed"
                    : Cause.hasDies(result.exit.cause)
                      ? "Defected"
                      : "Failed";
              append(`Activity.${activityOutcome}`, activity.name, { activityAttempt, result });
              return result;
            }),
          deferredDone: ({ deferredName, executionId, exit }) =>
            Effect.sync(() => {
              deferredJournal.set(`${executionId}:${deferredName}`, exit);
            }),
          deferredResult: (deferred) =>
            Effect.gen(function* () {
              const instance = yield* WorkflowEngine.WorkflowInstance;
              return Option.fromNullishOr(
                deferredJournal.get(`${instance.executionId}:${deferred.name}`),
              );
            }),
          execute: ((definition, options) => {
            const handler = workflows.get(definition._tag);
            if (handler === undefined) return Effect.die(`Workflow ${definition._tag} is missing`);
            if (options.discard) return Effect.void;
            const instance = WorkflowEngine.WorkflowInstance.initial(
              definition,
              options.executionId,
            );
            return handler(options.payload, options.executionId).pipe(
              EffectWorkflow.intoResult,
              Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
              Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            ) as Effect.Effect<EffectWorkflow.Result<unknown, unknown>>;
          }) as WorkflowEngine.Encoded["execute"],
          interrupt: () => Effect.void,
          interruptUnsafe: () => Effect.void,
          poll: () => Effect.succeed(Option.none()),
          register: (definition, handler) =>
            Effect.sync(() => {
              workflows.set(definition._tag, handler as never);
            }),
          resume: () => Effect.void,
          scheduleClock: (_definition, { clock: durableClock, executionId }) =>
            Effect.sync(() => {
              const key = `${executionId}:${durableClock.deferred.name}`;
              if (deferredJournal.has(key)) return;
              append("DurableClock.Scheduled", durableClock.name, {
                duration: Duration.toMillis(durableClock.duration),
              });
              currentTime += Duration.toMillis(durableClock.duration);
              deferredJournal.set(key, Exit.void);
              append("DurableClock.Completed", durableClock.name);
            }),
        });
        return engine;
      }),
    );

    const kernel = EffectWorkflow.make(`kojo:${workflow.name}`, {
      error: workflow.failure,
      idempotencyKey: () => runId,
      payload: { input: workflow.input },
      success: workflow.success,
    });
    const validate = (schema: Schema.Top, value: unknown) =>
      Schema.encodeUnknownEffect(schema)(value).pipe(Effect.as(value), Effect.orDie);
    let handler = Effect.suspend(() => workflow.run(input)).pipe(
      Effect.flatMap((value) => validate(workflow.success, value)),
      Effect.catchCause((cause) => {
        if (Cause.hasDies(cause)) return Effect.failCause(cause);
        const failure = Cause.findErrorOption(cause);
        if (Option.isNone(failure)) return Effect.failCause(cause);
        return validate(workflow.failure, failure.value).pipe(
          Effect.andThen(Effect.failCause(cause)),
        );
      }),
    ) as Effect.Effect<unknown, unknown, unknown>;
    if (makeOptions.layer !== undefined) {
      handler = handler.pipe(Effect.provide(makeOptions.layer as Layer.Layer<never, never, never>));
    }
    const handlerLayer = kernel.toLayer(() => handler).pipe(Layer.provide(engineLayer));
    const program = Effect.sync(() => {
      if (attempt === 1) append("WorkflowRun.Started", workflow.name, { input });
      else append("WorkflowRun.Restarted", workflow.name);
    }).pipe(
      Effect.andThen(kernel.execute({ input } as never)),
      Effect.provide(Layer.merge(engineLayer, handlerLayer)),
      Effect.provideService(Recorder, recorder),
      Effect.provideService(Clock.Clock, clock),
      Effect.scoped,
    );
    const exit = await Effect.runPromiseExit(program as Effect.Effect<unknown, unknown, never>);

    let state: WorkflowTest.Result<SuccessValue, FailureValue>["state"];
    let outcome: WorkflowTest.Outcome<SuccessValue, FailureValue>;
    // A terminal boundary cannot be interrupted after it has been committed.
    interruptionConsumed = true;
    if (interrupted) {
      state = "Interrupted";
      outcome = { _tag: "Interrupted" };
      try {
        append("WorkflowRun.Interrupted", workflow.name);
      } catch {
        // The configured interruption point has already been consumed.
      }
    } else if (Exit.isSuccess(exit)) {
      state = "Completed";
      outcome = { _tag: "Success", value: exit.value as SuccessValue };
      append("WorkflowRun.Completed", workflow.name, { value: exit.value });
    } else {
      state = "Failed";
      const failure = Cause.findErrorOption(exit.cause);
      if (!Cause.hasDies(exit.cause) && Option.isSome(failure)) {
        outcome = { _tag: "Failure", failure: failure.value as FailureValue };
      } else {
        outcome = { _tag: "Defect", cause: Cause.pretty(exit.cause) };
      }
      append("WorkflowRun.Failed", workflow.name, outcome);
    }

    return Object.freeze({
      attempt,
      calls: Object.freeze([...calls]),
      evidence: Object.freeze([...evidence]),
      outcome,
      runId,
      state,
      trace: Object.freeze([...traceFromEvidence(workflow.name, evidence)]),
    });
  };

  return Object.freeze({
    restart: async () => {
      if (!hasRun) throw new Error("WorkflowTest has not been run yet");
      if (latestResult === undefined) throw new Error("WorkflowTest is still running");
      if (latestResult.state !== "Interrupted") {
        throw new Error(`Cannot restart a Workflow Run in ${latestResult.state} state`);
      }
      latestResult = await execute(latestInput as Schema.Schema.Type<Input>);
      return latestResult;
    },
    run: async (input: Schema.Schema.Type<Input>, options?: WorkflowTest.RunOptions) => {
      if (hasRun) {
        throw new Error("WorkflowTest has already been run; use restart or create a new fixture");
      }
      hasRun = true;
      latestInput = input;
      latestResult = await execute(input, options);
      return latestResult;
    },
  });
};

const call = <A, E, R>(
  matcher: WorkflowTest.CallMatcher,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | RecorderService> =>
  Effect.gen(function* () {
    const recorder = yield* Recorder;
    return yield* recorder.call(matcher, effect);
  });

const nextId: Effect.Effect<string, never, RecorderService> = Recorder.pipe(
  Effect.flatMap((recorder) => recorder.nextId),
);

const assertCalls = (
  result: Pick<WorkflowTest.Result<unknown, unknown>, "calls">,
  expectations: {
    readonly forbidden?: ReadonlyArray<WorkflowTest.CallMatcher>;
    readonly required?: ReadonlyArray<WorkflowTest.CallMatcher>;
  },
) => {
  for (const required of expectations.required ?? []) {
    if (!result.calls.some((candidate) => matchesCall(candidate, required))) {
      throw new Error(
        `Required external call was not observed: ${required.layer}.${required.operation}`,
      );
    }
  }
  for (const forbidden of expectations.forbidden ?? []) {
    if (result.calls.some((candidate) => matchesCall(candidate, forbidden))) {
      throw new Error(
        `Forbidden external call was observed: ${forbidden.layer}.${forbidden.operation}`,
      );
    }
  }
};

const normalize = (value: unknown, options: WorkflowTest.NormalizeOptions = {}): unknown => {
  const ignored = new Set(options.ignore ?? []);
  const normalizeIds = options.ids !== false;
  const normalizeTimestamps = options.timestamps !== false;
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (current === null || typeof current !== "object") return current;
    return Object.fromEntries(
      Object.entries(current).flatMap(([key, entry]) => {
        if (ignored.has(key)) return [];
        if (normalizeIds && /^(?:event|execution|leaseHolder|rootRun|run)Id$/.test(key)) {
          return [[key, "<id>"]];
        }
        if (normalizeTimestamps && /(?:^|[a-z])At$/.test(key)) {
          return [[key, "<timestamp>"]];
        }
        return [[key, visit(entry)]];
      }),
    );
  };
  return visit(value);
};

export const WorkflowTest = Object.freeze({ assertCalls, call, make, nextId, normalize });
