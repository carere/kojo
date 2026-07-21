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
  Scope,
} from "effect";
import { Workflow as EffectWorkflow, WorkflowEngine } from "effect/unstable/workflow";
import { CompositionRuntime } from "./composition";
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
    readonly type: "Activity" | "ChildWorkflow" | "DurableClock" | "ExternalCall" | "WorkflowRun";
  }

  export interface RevisionSnapshotEntry {
    readonly entryPoint: string;
    readonly stableName: string;
    readonly version: string;
  }

  export type Outcome<Success, Failure> =
    | { readonly _tag: "Success"; readonly value: Success }
    | { readonly _tag: "Failure"; readonly failure: Failure }
    | { readonly _tag: "Defect"; readonly cause: string }
    | { readonly _tag: "Discarded" }
    | { readonly _tag: "Interrupted" }
    | { readonly _tag: "Suspended" };

  export interface Result<Success, Failure> {
    readonly attempt: number;
    readonly calls: ReadonlyArray<Call>;
    readonly children: ReadonlyArray<Result<unknown, unknown>>;
    readonly evidence: ReadonlyArray<EvidenceEvent>;
    readonly input: unknown;
    readonly outcome: Outcome<Success, Failure>;
    readonly parentRunId: string | null;
    readonly revisionSnapshot: ReadonlyArray<RevisionSnapshotEntry>;
    readonly rootRunId: string;
    readonly runId: string;
    readonly state: "Completed" | "Discarded" | "Failed" | "Interrupted" | "Suspended";
    readonly trace: ReadonlyArray<TraceSpan>;
    readonly workflowName: string;
  }

  export interface RunOptions {
    readonly interruptAfter?: {
      readonly subject?: string;
      readonly type: string;
    };
    readonly suspendAfter?: {
      readonly subject?: string;
      readonly type: string;
    };
    readonly uncertain?: ReadonlyArray<CallMatcher>;
  }

  export interface MakeOptions<Requirements> {
    readonly clock?: Date | number | string;
    readonly ids?: Iterable<string>;
    readonly layer?: Layer.Layer<Requirements, never, never>;
    readonly workflows?: ReadonlyArray<
      WorkflowDefinition<string, Schema.Top, Schema.Top, Schema.Top, unknown>
    >;
  }

  export interface Fixture<Input, Success, Failure> {
    readonly discard: () => Promise<Result<Success, Failure>>;
    readonly restart: () => Promise<Result<Success, Failure>>;
    readonly resume: () => Promise<Result<Success, Failure>>;
    readonly run: (input: Input, options?: RunOptions) => Promise<Result<Success, Failure>>;
  }

  export interface NormalizeOptions {
    readonly ignore?: ReadonlyArray<string>;
    readonly ids?: boolean;
    readonly timestamps?: boolean;
  }
}

interface RunRecord {
  attempt: number;
  readonly calls: Array<WorkflowTest.Call>;
  readonly childRunIds: Array<string>;
  readonly evidence: Array<WorkflowTest.EvidenceEvent>;
  input: unknown;
  outcome?: WorkflowTest.Outcome<unknown, unknown>;
  readonly parentRunId: string | null;
  readonly rootRunId: string;
  readonly runId: string;
  state?: WorkflowTest.Result<unknown, unknown>["state"];
  readonly workflow: WorkflowDefinition<string, Schema.Top, Schema.Top, Schema.Top, unknown>;
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
class SuspendedSignal extends Error {}
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
    [
      "WorkflowRun.Completed",
      "WorkflowRun.Discarded",
      "WorkflowRun.Failed",
      "WorkflowRun.Interrupted",
      "WorkflowRun.Suspended",
    ].includes(type),
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
  const rootWorkflow = workflow as WorkflowDefinition<
    string,
    Schema.Top,
    Schema.Top,
    Schema.Top,
    unknown
  >;
  const rootRecord: RunRecord = {
    attempt: 0,
    calls,
    childRunIds: [],
    evidence,
    input: undefined,
    parentRunId: null,
    rootRunId: runId,
    runId,
    workflow: rootWorkflow,
  };
  const runs = new Map<string, RunRecord>([[runId, rootRecord]]);
  const childBindings = new Map<
    string,
    {
      readonly input: unknown;
      readonly runId: string;
      readonly workflow: WorkflowDefinition<string, Schema.Top, Schema.Top, Schema.Top, unknown>;
    }
  >();
  const registry = new Map(
    [rootWorkflow, ...(makeOptions.workflows ?? [])].map((definition) => [
      definition.name,
      definition as WorkflowDefinition<string, Schema.Top, Schema.Top, Schema.Top, unknown>,
    ]),
  );
  const revisionSnapshot = Object.freeze(
    [...registry.values()].map(({ entryPoint, name, version }) =>
      Object.freeze({ entryPoint, stableName: name, version }),
    ),
  );
  const activityJournal = new Map<string, EffectWorkflow.Result<unknown, unknown>>();
  const callJournal = new Map<
    string,
    { readonly exit?: Exit.Exit<unknown, unknown>; readonly uncertain: boolean }
  >();
  const controlJournal = new Set<string>();
  const runtimeConfigurations = new Map<string, unknown>();
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
    currentTimeNanos: Effect.sync(
      () => BigInt(Number.isFinite(currentTime) ? Math.trunc(currentTime) : 0) * 1_000_000n,
    ),
    currentTimeNanosUnsafe: () =>
      BigInt(Number.isFinite(currentTime) ? Math.trunc(currentTime) : 0) * 1_000_000n,
    sleep: (duration) => {
      const milliseconds = Duration.toMillis(duration);
      return Number.isFinite(milliseconds)
        ? Effect.sync(() => {
            currentTime += milliseconds;
          })
        : Effect.never;
    },
  };

  const project = (record: RunRecord): WorkflowTest.Result<unknown, unknown> =>
    Object.freeze({
      attempt: record.attempt,
      calls: Object.freeze([...record.calls]),
      children: Object.freeze(
        record.childRunIds.map((childRunId) => project(runs.get(childRunId) as RunRecord)),
      ),
      evidence: Object.freeze([...record.evidence]),
      input: structuredClone(record.input),
      outcome: record.outcome as WorkflowTest.Outcome<unknown, unknown>,
      parentRunId: record.parentRunId,
      revisionSnapshot,
      rootRunId: record.rootRunId,
      runId: record.runId,
      state: record.state as WorkflowTest.Result<unknown, unknown>["state"],
      trace: Object.freeze([
        ...traceFromEvidence(record.workflow.name, record.evidence),
        ...record.childRunIds.map((childRunId) => {
          const linked = record.evidence.find(
            ({ details, type }) =>
              type === "ChildWorkflow.Linked" &&
              typeof details === "object" &&
              details !== null &&
              "childRunId" in details &&
              details.childRunId === childRunId,
          );
          const childRecord = runs.get(childRunId) as RunRecord;
          return {
            attempt: linked?.attempt ?? record.attempt,
            outcome: childRecord.state,
            sequence: linked?.sequence ?? 1,
            subject: childRecord.workflow.name,
            type: "ChildWorkflow" as const,
          };
        }),
      ]),
      workflowName: record.workflow.name,
    });

  const failureTag = (record: RunRecord) => {
    const failure = record.outcome?._tag === "Failure" ? record.outcome.failure : undefined;
    return typeof failure === "object" &&
      failure !== null &&
      "_tag" in failure &&
      typeof failure._tag === "string"
      ? failure._tag
      : undefined;
  };

  const hasRecoverableFailure = (record: RunRecord): boolean => {
    const tag = failureTag(record);
    if (tag !== undefined && record.workflow.recovery[tag] !== undefined) return true;
    return record.childRunIds.some((childRunId) =>
      hasRecoverableFailure(runs.get(childRunId) as RunRecord),
    );
  };

  const execute = async (
    input: Schema.Schema.Type<Input>,
    runOptions: WorkflowTest.RunOptions = {},
  ): Promise<WorkflowTest.Result<SuccessValue, FailureValue>> => {
    attempt += 1;
    const resumedState = latestResult?.state;
    const recoveryFailure =
      resumedState === "Failed" && latestResult?.outcome._tag === "Failure"
        ? latestResult.outcome.failure
        : undefined;
    const callOrdinals = new Map<string, number>();
    let interrupted = false;
    let suspended = false;
    let interruptionConsumed = false;

    const append = (run: RunRecord, type: string, subject: string, details?: unknown) => {
      const event: WorkflowTest.EvidenceEvent = Object.freeze({
        attempt: run.attempt,
        ...(details === undefined ? {} : { details }),
        eventId: `event-${[...runs.values()].reduce((total, item) => total + item.evidence.length, 0) + 1}`,
        recordedAt: new Date(currentTime).toISOString(),
        sequence: run.evidence.length + 1,
        subject,
        type,
      });
      run.evidence.push(event);
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
      if (
        !interruptionConsumed &&
        runOptions.suspendAfter?.type === type &&
        (runOptions.suspendAfter.subject === undefined ||
          runOptions.suspendAfter.subject === subject)
      ) {
        interruptionConsumed = true;
        suspended = true;
        throw new SuspendedSignal();
      }
      return event;
    };

    const appendWithoutLifecycleCompensation = (type: string, subject: string, details?: unknown) =>
      Effect.gen(function* () {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const currentRun = yield* CompositionRuntime.WorkflowRunContext;
        const run = runs.get(currentRun.runId);
        if (run === undefined)
          return yield* Effect.die(`Workflow Run ${currentRun.runId} is missing`);
        try {
          append(run, type, subject, details);
        } catch (error) {
          if (error instanceof InterruptedSignal || error instanceof SuspendedSignal) {
            yield* Scope.close(instance.scope, Exit.void);
          }
          return yield* Effect.die(error);
        }
      });

    const boundaryRecorder = {
      record: (boundary: {
        readonly details?: unknown;
        readonly idempotencyKey: string;
        readonly subject: string;
        readonly type: string;
      }) =>
        Effect.gen(function* () {
          const currentRun = yield* CompositionRuntime.WorkflowRunContext;
          const journalKey = `${currentRun.runId}:${boundary.idempotencyKey}`;
          if (controlJournal.has(journalKey)) return;
          controlJournal.add(journalKey);
          yield* appendWithoutLifecycleCompensation(
            boundary.type,
            boundary.subject,
            boundary.details,
          );
        }) as Effect.Effect<void>,
    };

    const runtimeConfigurationRecorder = {
      verify: (subject: string, snapshot: unknown) =>
        Effect.gen(function* () {
          const currentRun = yield* CompositionRuntime.WorkflowRunContext;
          const configurationKey = `${currentRun.runId}:${subject}`;
          const existing = runtimeConfigurations.get(configurationKey);
          if (existing === undefined) {
            runtimeConfigurations.set(configurationKey, structuredClone(snapshot));
            yield* appendWithoutLifecycleCompensation(
              "RuntimeConfiguration.SnapshotRecorded",
              subject,
              snapshot,
            );
            return;
          }
          if (!Equal.equals(existing, snapshot)) {
            yield* appendWithoutLifecycleCompensation(
              "RuntimeConfiguration.Incompatible",
              subject,
              {
                available: snapshot,
                expected: existing,
              },
            );
            return yield* Effect.die(
              `Runtime Configuration for '${subject}' does not match its durable snapshot`,
            );
          }
          yield* appendWithoutLifecycleCompensation(
            "RuntimeConfiguration.Compatible",
            subject,
            snapshot,
          );
        }),
    };

    const recorder: RecorderService = {
      call: (matcher, effect) =>
        Effect.gen(function* () {
          const currentRun = yield* CompositionRuntime.WorkflowRunContext;
          const run = runs.get(currentRun.runId);
          if (run === undefined)
            return yield* Effect.die(`Workflow Run ${currentRun.runId} is missing`);
          const ordinalKey = `${run.runId}:${matcher.layer}.${matcher.operation}`;
          const ordinal = (callOrdinals.get(ordinalKey) ?? 0) + 1;
          callOrdinals.set(ordinalKey, ordinal);
          const journalKey = `${run.runId}:${ordinalKey}:${ordinal}`;
          const stored = callJournal.get(journalKey);
          const subject = `${matcher.layer}.${matcher.operation}`;
          if (stored?.uncertain === true) {
            interrupted = true;
            append(run, "ExternalCall.Uncertain", subject, { input: matcher.input, ordinal });
            return yield* Effect.die(new UncertainSignal());
          }
          if (stored?.exit !== undefined) {
            append(run, "ExternalCall.Replayed", subject, { input: matcher.input, ordinal });
            if (Exit.isSuccess(stored.exit)) return stored.exit.value as never;
            return yield* Effect.failCause(stored.exit.cause as Cause.Cause<never>);
          }

          append(run, "ExternalCall.Started", subject, { input: matcher.input, ordinal });
          const callRecord: WorkflowTest.Call = {
            attempt,
            input: matcher.input,
            layer: matcher.layer,
            operation: matcher.operation,
            ordinal,
            status: "Completed",
          };
          run.calls.push(callRecord);
          const exit = yield* Effect.exit(effect);
          const uncertain = runOptions.uncertain?.some((candidate) =>
            matchesCall(matcher, candidate),
          );
          if (uncertain === true) {
            run.calls[run.calls.length - 1] = { ...callRecord, status: "Uncertain" };
            callJournal.set(journalKey, { uncertain: true });
            append(run, "ExternalCall.Uncertain", subject, { input: matcher.input, ordinal });
            interrupted = true;
            return yield* Effect.die(new UncertainSignal());
          }
          callJournal.set(journalKey, { exit, uncertain: false });
          if (Exit.isSuccess(exit)) {
            append(run, "ExternalCall.Completed", subject, { ordinal, output: exit.value });
            return exit.value;
          }
          run.calls[run.calls.length - 1] = { ...callRecord, status: "Failed" };
          append(run, "ExternalCall.Failed", subject, { ordinal });
          return yield* Effect.failCause(exit.cause);
        }),
      nextId: Effect.sync(() => ids.shift() ?? `id-${++generatedId}`),
    };

    const validateValue = (schema: Schema.Top, value: unknown) =>
      Schema.encodeUnknownEffect(schema)(value).pipe(Effect.as(value), Effect.orDie);

    const childWorkflowInvoker = {
      invoke: (
        candidate: unknown,
        key: string,
        input: unknown,
      ): Effect.Effect<unknown, unknown, unknown> =>
        Effect.gen(function* () {
          if (key.length === 0 || key !== key.trim()) {
            return yield* Effect.die("Child Workflow invocation requires a non-empty stable key");
          }
          const definition = candidate as WorkflowDefinition<
            string,
            Schema.Top,
            Schema.Top,
            Schema.Top,
            unknown
          >;
          const selected = registry.get(definition.name);
          if (
            selected === undefined ||
            selected !== definition ||
            selected.version !== definition.version ||
            selected.entryPoint !== definition.entryPoint
          ) {
            return yield* Effect.die(
              `Child Workflow '${definition.name}' is not part of the root Workflow Revision Snapshot`,
            );
          }
          const current = yield* CompositionRuntime.WorkflowRunContext;
          const parent = runs.get(current.runId);
          if (parent === undefined)
            return yield* Effect.die(`Workflow Run ${current.runId} is missing`);
          const path = yield* CompositionRuntime.DurablePath;
          const invocationKey = `${parent.runId}:${JSON.stringify([...path, key])}`;
          const existing = childBindings.get(invocationKey);
          let child: RunRecord;
          if (existing === undefined) {
            const childRunId = `run-${runs.size + 1}`;
            child = {
              attempt: 0,
              calls: [],
              childRunIds: [],
              evidence: [],
              input: structuredClone(input),
              parentRunId: parent.runId,
              rootRunId: parent.rootRunId,
              runId: childRunId,
              workflow: definition,
            };
            runs.set(childRunId, child);
            parent.childRunIds.push(childRunId);
            childBindings.set(invocationKey, {
              input: structuredClone(input),
              runId: childRunId,
              workflow: definition,
            });
            append(parent, "ChildWorkflow.Linked", parent.workflow.name, {
              childRunId,
              input,
              key,
              workflow: definition.name,
            });
          } else {
            if (
              existing.workflow.name !== definition.name ||
              existing.workflow.version !== definition.version ||
              existing.workflow.entryPoint !== definition.entryPoint ||
              !Equal.equals(existing.input, input)
            ) {
              return yield* Effect.die(
                `Child Workflow invocation key '${key}' cannot be retargeted to different input or workflow`,
              );
            }
            const joined = runs.get(existing.runId);
            if (joined === undefined)
              return yield* Effect.die(`Workflow Run ${existing.runId} is missing`);
            child = joined;
            append(parent, "ChildWorkflow.Rejoined", parent.workflow.name, {
              childRunId: child.runId,
              key,
            });
            if (child.state === "Completed" && child.outcome?._tag === "Success") {
              return child.outcome.value;
            }
            if (child.state === "Failed" && child.outcome?._tag === "Failure") {
              if (!hasRecoverableFailure(child)) return yield* Effect.fail(child.outcome.failure);
              const tag = failureTag(child);
              const recoveryHandler = tag === undefined ? undefined : child.workflow.recovery[tag];
              if (recoveryHandler !== undefined && tag !== undefined) {
                append(child, "Recovery.Started", tag);
                const recoveryExit = yield* Effect.exit(
                  recoveryHandler(child.outcome.failure).pipe(
                    Effect.provideService(CompositionRuntime.WorkflowRunContext, {
                      runId: child.runId,
                    }),
                  ),
                );
                append(
                  child,
                  Exit.isSuccess(recoveryExit) ? "Recovery.Completed" : "Recovery.Failed",
                  tag,
                  Exit.isFailure(recoveryExit)
                    ? { cause: Cause.pretty(recoveryExit.cause) }
                    : undefined,
                );
                if (Exit.isFailure(recoveryExit))
                  return yield* Effect.failCause(recoveryExit.cause);
              }
            }
            if (child.state === "Failed" && child.outcome?._tag === "Defect") {
              return yield* Effect.die(child.outcome.cause);
            }
          }

          child.attempt += 1;
          child.state = undefined;
          child.outcome = undefined;
          append(
            child,
            child.attempt === 1 ? "WorkflowRun.Started" : "WorkflowRun.Restarted",
            definition.name,
            child.attempt === 1 ? { input } : undefined,
          );
          const parentInstance = yield* WorkflowEngine.WorkflowInstance;
          const childInstance = WorkflowEngine.WorkflowInstance.initial(
            parentInstance.workflow,
            child.runId,
          );
          const childExit = yield* Effect.exit(
            Effect.suspend(() => definition.run(input)).pipe(
              Effect.flatMap((value) => validateValue(definition.success, value)),
              Effect.catchCause((cause) => {
                if (Cause.hasDies(cause)) return Effect.failCause(cause);
                const failure = Cause.findErrorOption(cause);
                if (Option.isNone(failure)) return Effect.failCause(cause);
                return validateValue(definition.failure, failure.value).pipe(
                  Effect.andThen(Effect.failCause(cause)),
                );
              }),
              Effect.provideService(CompositionRuntime.DurablePath, []),
              Effect.provideService(CompositionRuntime.ExecutionAttempt, child.attempt),
              Effect.provideService(CompositionRuntime.WorkflowRunContext, { runId: child.runId }),
              Effect.provideService(WorkflowEngine.WorkflowInstance, childInstance),
            ),
          );
          if (interrupted) {
            child.state = "Interrupted";
            child.outcome = { _tag: "Interrupted" };
            append(child, "WorkflowRun.Interrupted", definition.name);
            return yield* Exit.isFailure(childExit)
              ? Effect.failCause(childExit.cause)
              : Effect.die("Child Workflow was interrupted after producing a result");
          }
          if (suspended) {
            child.state = "Suspended";
            child.outcome = { _tag: "Suspended" };
            append(child, "WorkflowRun.Suspended", definition.name);
            return yield* Exit.isFailure(childExit)
              ? Effect.failCause(childExit.cause)
              : Effect.die("Child Workflow was suspended after producing a result");
          }
          if (Exit.isSuccess(childExit)) {
            child.state = "Completed";
            child.outcome = { _tag: "Success", value: childExit.value };
            append(child, "WorkflowRun.Completed", definition.name, { value: childExit.value });
            append(parent, "ChildWorkflow.Completed", parent.workflow.name, {
              childRunId: child.runId,
              result: childExit.value,
            });
            return childExit.value;
          }
          child.state = "Failed";
          if (Cause.hasInterrupts(childExit.cause)) {
            child.outcome = {
              _tag: "Failure",
              failure: {
                _tag: "ChildWorkflow.Cancelled",
                reason: "ParentStoppedAwaiting",
              },
            };
            append(child, "WorkflowRun.Failed", definition.name, child.outcome);
            append(parent, "ChildWorkflow.Failed", parent.workflow.name, {
              cause: { runId: child.runId, type: "Cancellation" },
              childRunId: child.runId,
            });
            return yield* Effect.failCause(childExit.cause);
          }
          const failure = Cause.findErrorOption(childExit.cause);
          if (!Cause.hasDies(childExit.cause) && Option.isSome(failure)) {
            child.outcome = { _tag: "Failure", failure: failure.value };
            append(child, "WorkflowRun.Failed", definition.name, child.outcome);
            append(parent, "ChildWorkflow.Failed", parent.workflow.name, {
              cause: { runId: child.runId, type: "TypedFailure" },
              childRunId: child.runId,
            });
            return yield* Effect.failCause(childExit.cause);
          }
          child.outcome = { _tag: "Defect", cause: Cause.pretty(childExit.cause) };
          append(child, "WorkflowRun.Failed", definition.name, child.outcome);
          append(parent, "ChildWorkflow.Defected", parent.workflow.name, {
            cause: { runId: child.runId, type: "Defect" },
            childRunId: child.runId,
          });
          return yield* Effect.failCause(childExit.cause);
        }),
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
              const currentRun = yield* CompositionRuntime.WorkflowRunContext;
              const run = runs.get(currentRun.runId);
              if (run === undefined)
                return yield* Effect.die(`Workflow Run ${currentRun.runId} is missing`);
              const subject = yield* CompositionRuntime.activitySubject(activity.name);
              const idempotencyKey = `${parent.executionId}:${subject}`;
              const details = {
                activityAttempt,
                idempotencyKey,
                logicalIdentity: subject,
                ordinal: activityAttempt,
              };
              const key = `${idempotencyKey}:${activityAttempt}`;
              const stored = activityJournal.get(key);
              if (stored !== undefined) {
                append(run, "Activity.Replayed", subject, details);
                return stored;
              }
              append(run, "Activity.Started", subject, details);
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
              append(run, `Activity.${activityOutcome}`, subject, { ...details, result });
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
            Effect.gen(function* () {
              const key = `${executionId}:${durableClock.deferred.name}`;
              if (deferredJournal.has(key)) return;
              yield* appendWithoutLifecycleCompensation(
                "DurableClock.Scheduled",
                durableClock.name,
                { duration: Duration.toMillis(durableClock.duration) },
              );
              const milliseconds = Duration.toMillis(durableClock.duration);
              if (Number.isFinite(milliseconds)) currentTime += milliseconds;
              deferredJournal.set(key, Exit.void);
              yield* appendWithoutLifecycleCompensation(
                "DurableClock.Completed",
                durableClock.name,
              );
            }) as Effect.Effect<void>,
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
    let handler = Effect.suspend(() => workflow.run(input)).pipe(
      Effect.flatMap((value) => validateValue(workflow.success, value)),
      Effect.catchCause((cause) => {
        if (Cause.hasDies(cause)) return Effect.failCause(cause);
        const failure = Cause.findErrorOption(cause);
        if (Option.isNone(failure)) return Effect.failCause(cause);
        return validateValue(workflow.failure, failure.value).pipe(
          Effect.andThen(Effect.failCause(cause)),
        );
      }),
    ) as Effect.Effect<unknown, unknown, unknown>;
    handler = handler.pipe(
      Effect.provideService(CompositionRuntime.BoundaryRecorder, boundaryRecorder),
      Effect.provideService(
        CompositionRuntime.RuntimeConfigurationRecorder,
        runtimeConfigurationRecorder,
      ),
      Effect.provideService(CompositionRuntime.ExecutionAttempt, attempt),
      Effect.provideService(CompositionRuntime.ChildWorkflowInvoker, childWorkflowInvoker),
      Effect.provideService(CompositionRuntime.WorkflowRunContext, { runId }),
    );
    if (makeOptions.layer !== undefined) {
      handler = handler.pipe(Effect.provide(makeOptions.layer as Layer.Layer<never, never, never>));
    }
    const handlerLayer = kernel.toLayer(() => handler).pipe(Layer.provide(engineLayer));
    const recoveryTag =
      typeof recoveryFailure === "object" &&
      recoveryFailure !== null &&
      "_tag" in recoveryFailure &&
      typeof recoveryFailure._tag === "string"
        ? recoveryFailure._tag
        : undefined;
    const recoveryHandler = recoveryTag === undefined ? undefined : workflow.recovery[recoveryTag];
    const recoveryInstance = WorkflowEngine.WorkflowInstance.initial(
      kernel as EffectWorkflow.Any,
      runId,
    );
    const recoveryEffect = (
      recoveryHandler === undefined || recoveryTag === undefined
        ? Effect.void
        : Effect.gen(function* () {
            append(rootRecord, "Recovery.Started", recoveryTag);
            const recoveryExit = yield* Effect.exit(recoveryHandler(recoveryFailure as never));
            append(
              rootRecord,
              Exit.isSuccess(recoveryExit) ? "Recovery.Completed" : "Recovery.Failed",
              recoveryTag,
              Exit.isSuccess(recoveryExit)
                ? undefined
                : { cause: Cause.pretty(recoveryExit.cause) },
            );
            if (Exit.isFailure(recoveryExit)) return yield* Effect.failCause(recoveryExit.cause);
          })
    ).pipe(Effect.provideService(WorkflowEngine.WorkflowInstance, recoveryInstance));
    const recovery =
      makeOptions.layer === undefined
        ? recoveryEffect
        : recoveryEffect.pipe(
            Effect.provide(makeOptions.layer as Layer.Layer<never, never, never>),
          );
    const program = Effect.sync(() => {
      rootRecord.attempt = attempt;
      rootRecord.input = structuredClone(input);
      if (attempt === 1) append(rootRecord, "WorkflowRun.Started", workflow.name, { input });
      else
        append(
          rootRecord,
          resumedState === "Suspended" ? "WorkflowRun.Resumed" : "WorkflowRun.Restarted",
          workflow.name,
        );
    }).pipe(
      Effect.andThen(recovery),
      Effect.andThen(kernel.execute({ input } as never)),
      Effect.provide(Layer.merge(engineLayer, handlerLayer)),
      Effect.provideService(Recorder, recorder),
      Effect.provideService(Clock.Clock, clock),
      Effect.provideService(CompositionRuntime.WorkflowRunContext, { runId }),
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
        append(rootRecord, "WorkflowRun.Interrupted", workflow.name);
      } catch {
        // The configured interruption point has already been consumed.
      }
    } else if (suspended) {
      state = "Suspended";
      outcome = { _tag: "Suspended" };
      append(rootRecord, "WorkflowRun.Suspended", workflow.name);
    } else if (Exit.isSuccess(exit)) {
      state = "Completed";
      outcome = { _tag: "Success", value: exit.value as SuccessValue };
      append(rootRecord, "WorkflowRun.Completed", workflow.name, { value: exit.value });
    } else {
      state = "Failed";
      const failure = Cause.findErrorOption(exit.cause);
      if (!Cause.hasDies(exit.cause) && Option.isSome(failure)) {
        outcome = { _tag: "Failure", failure: failure.value as FailureValue };
      } else {
        outcome = { _tag: "Defect", cause: Cause.pretty(exit.cause) };
      }
      append(rootRecord, "WorkflowRun.Failed", workflow.name, outcome);
    }

    rootRecord.state = state;
    rootRecord.outcome = outcome;

    return project(rootRecord) as WorkflowTest.Result<SuccessValue, FailureValue>;
  };

  return Object.freeze({
    discard: async () => {
      if (!hasRun) throw new Error("WorkflowTest has not been run yet");
      if (latestResult === undefined) throw new Error("WorkflowTest is still running");
      if (latestResult.state === "Completed" || latestResult.state === "Discarded") {
        throw new Error(`Cannot discard a Workflow Run in ${latestResult.state} state`);
      }
      const discardTree = (record: RunRecord): void => {
        for (const childRunId of [...record.childRunIds].reverse()) {
          discardTree(runs.get(childRunId) as RunRecord);
        }
        if (record.state === "Completed" || record.state === "Discarded") return;
        record.state = "Discarded";
        record.outcome = { _tag: "Discarded" };
        record.evidence.push(
          Object.freeze({
            attempt: record.attempt,
            eventId: `event-${[...runs.values()].reduce((total, item) => total + item.evidence.length, 0) + 1}`,
            recordedAt: new Date(currentTime).toISOString(),
            sequence: record.evidence.length + 1,
            subject: record.workflow.name,
            type: "WorkflowRun.Discarded",
          }),
        );
      };
      discardTree(rootRecord);
      latestResult = project(rootRecord) as WorkflowTest.Result<SuccessValue, FailureValue>;
      return latestResult;
    },
    restart: async () => {
      if (!hasRun) throw new Error("WorkflowTest has not been run yet");
      if (latestResult === undefined) throw new Error("WorkflowTest is still running");
      if (latestResult.state !== "Interrupted") {
        throw new Error(`Cannot restart a Workflow Run in ${latestResult.state} state`);
      }
      if (latestResult.calls.some(({ status }) => status === "Uncertain")) {
        throw new Error("Cannot restart a Workflow Run with an unreconciled uncertain outcome");
      }
      latestResult = await execute(latestInput as Schema.Schema.Type<Input>);
      return latestResult;
    },
    resume: async () => {
      if (!hasRun) throw new Error("WorkflowTest has not been run yet");
      if (latestResult === undefined) throw new Error("WorkflowTest is still running");
      const rootFailureTag =
        latestResult.outcome._tag === "Failure" &&
        typeof latestResult.outcome.failure === "object" &&
        latestResult.outcome.failure !== null &&
        "_tag" in latestResult.outcome.failure &&
        typeof latestResult.outcome.failure._tag === "string"
          ? latestResult.outcome.failure._tag
          : undefined;
      const recoverableFailure =
        latestResult.state === "Failed" &&
        ((rootFailureTag !== undefined && workflow.recovery[rootFailureTag] !== undefined) ||
          hasRecoverableFailure(rootRecord));
      if (latestResult.calls.some(({ status }) => status === "Uncertain")) {
        throw new Error("Cannot resume a Workflow Run with an unreconciled uncertain outcome");
      }
      if (
        latestResult.state !== "Interrupted" &&
        latestResult.state !== "Suspended" &&
        !recoverableFailure
      ) {
        throw new Error(`Cannot resume a Workflow Run in ${latestResult.state} state`);
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
