import { Context, Data, type Duration, Effect, Schema } from "effect";

export const ProjectIdentity = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    expected: "a full Project Identity",
  }),
).pipe(Schema.brand("ProjectIdentity"));
export type ProjectIdentity = typeof ProjectIdentity.Type;

export const WorkflowKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand("WorkflowKey"),
);
export type WorkflowKey = typeof WorkflowKey.Type;

export const WorkflowDefinitionRevision = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
).pipe(Schema.brand("WorkflowDefinitionRevision"));
export type WorkflowDefinitionRevision = typeof WorkflowDefinitionRevision.Type;

export type WorkflowScheduleOverlapPolicy = "allow" | "skip";

/**
 * The only values an authored schedule input rule can receive. The instant is
 * an absolute UTC instant; authors can format it in the schedule's declared
 * time zone when their input needs local-calendar information.
 */
export interface WorkflowScheduleInput {
  readonly scheduleKey: string;
  readonly scheduledAt: Date;
}

/**
 * An explicit revision is the author's compatibility declaration for a
 * deterministic schedule-input calculation.
 */
export interface WorkflowScheduleInputRule<Input> {
  readonly revision: string;
  readonly resolve: (occurrence: WorkflowScheduleInput) => Input;
}

/** A recurring trigger attached to one Workflow Definition. */
export interface WorkflowSchedule<Input> {
  readonly scheduleKey: string;
  /** Must name the Workflow Definition that owns this attached Schedule. */
  readonly workflowKey: string;
  /** A standard five-field cron expression (minute through weekday). */
  readonly cron: string;
  /** An explicit IANA time-zone name, for example "Europe/Paris". */
  readonly timeZone: string;
  readonly overlap?: WorkflowScheduleOverlapPolicy;
  readonly input: WorkflowScheduleInputRule<Input>;
}

/**
 * An opaque, serializable reference to one durable Workflow Deferred.
 *
 * The token is deliberately the only deferred identity visible to workflow
 * authors and control clients. It does not expose an Effect Workflow identity.
 */
export const WorkflowDeferredToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
).pipe(Schema.brand("WorkflowDeferredToken"));
export type WorkflowDeferredToken = typeof WorkflowDeferredToken.Type;

/** A durable value wait created by {@link Workflow.deferred}. */
export interface WorkflowDeferred<Success> {
  readonly token: WorkflowDeferredToken;
  /** Type-only marker; it is never populated at runtime. */
  readonly _success?: Success;
}

export interface WorkflowOperations {
  readonly sleep: (options: {
    readonly operationKey: string;
    readonly duration: Duration.Input;
  }) => Effect.Effect<void>;
  readonly deferred: <Success extends Schema.Top>(options: {
    readonly operationKey: string;
    readonly successSchema: Success;
  }) => Effect.Effect<WorkflowDeferred<Success["Type"]>>;
  readonly awaitDeferred: <Success>(deferred: WorkflowDeferred<Success>) => Effect.Effect<Success>;
  readonly waitForResume: <Success extends Schema.Top>(options: {
    readonly operationKey: string;
    readonly valueSchema: Success;
  }) => Effect.Effect<Success["Type"]>;
}

/** The durable outcome reported when an invoked Child Workflow Run fails. */
export class WorkflowChildFailure extends Data.TaggedError("WorkflowChildFailure")<{
  readonly invocationKey: string;
  readonly runId: string;
  readonly workflowKey: string;
}> {}

export interface WorkflowChildInvocation {
  /** A developer-chosen, stable identity for this invocation in its parent Run. */
  readonly invocationKey: string;
  /** Must be declared by the parent Workflow Definition's childWorkflowKeys. */
  readonly workflowKey: string;
  /** The input for the explicitly registered target Workflow Definition. */
  readonly input: unknown;
}

export interface WorkflowChildRuntimeShape {
  readonly invoke: (
    invocation: WorkflowChildInvocation,
  ) => Effect.Effect<unknown, WorkflowChildFailure>;
}

/** Host-provided runtime for durable Child Workflow Runs. */
export class WorkflowChildRuntime extends Context.Service<
  WorkflowChildRuntime,
  WorkflowChildRuntimeShape
>()("kojo/workflow/WorkflowChildRuntime") {}

const unavailableOperations: WorkflowOperations = {
  sleep: () =>
    Effect.die("Kojo Workflow operations are only available inside a Workflow Definition."),
  deferred: () =>
    Effect.die("Kojo Workflow operations are only available inside a Workflow Definition."),
  awaitDeferred: () =>
    Effect.die("Kojo Workflow operations are only available inside a Workflow Definition."),
  waitForResume: () =>
    Effect.die("Kojo Workflow operations are only available inside a Workflow Definition."),
};

/**
 * The Host supplies this implementation while executing a Workflow Definition.
 * It is a defaulted Context reference so author handlers remain closed Effects.
 */
export const WorkflowOperations = Context.Reference<WorkflowOperations>(
  "kojo/workflow/operations",
  {
    defaultValue: () => unavailableOperations,
  },
);

/**
 * Stable durable primitives available inside a Workflow Definition.
 *
 * Each operation accepts a developer-chosen Durable Operation Key. Effect's
 * private workflow, clock, and deferred identities never cross this API.
 */
export const Workflow = {
  sleep: (options: { readonly operationKey: string; readonly duration: Duration.Input }) =>
    Effect.flatMap(WorkflowOperations, (operations) => operations.sleep(options)),
  deferred: <Success extends Schema.Top>(options: {
    readonly operationKey: string;
    readonly successSchema: Success;
  }) => Effect.flatMap(WorkflowOperations, (operations) => operations.deferred(options)),
  await: <Success>(deferred: WorkflowDeferred<Success>) =>
    Effect.flatMap(WorkflowOperations, (operations) => operations.awaitDeferred(deferred)),
  waitForResume: <Success extends Schema.Top>(options: {
    readonly operationKey: string;
    readonly valueSchema: Success;
  }) => Effect.flatMap(WorkflowOperations, (operations) => operations.waitForResume(options)),
  invokeChild: (invocation: WorkflowChildInvocation) =>
    Effect.flatMap(WorkflowChildRuntime, (runtime) => runtime.invoke(invocation)),
  /** Alias for invokeChild, emphasizing that the returned Effect waits for the child outcome. */
  startChild: (invocation: WorkflowChildInvocation) =>
    Effect.flatMap(WorkflowChildRuntime, (runtime) => runtime.invoke(invocation)),
};

/**
 * Paths in a value schema that contain sensitive values. Paths use dot notation;
 * an empty array means that the corresponding value contains no marked fields.
 */
export interface WorkflowSensitivity {
  readonly input?: ReadonlyArray<string>;
  readonly success?: ReadonlyArray<string>;
  readonly failure?: ReadonlyArray<string>;
}

/**
 * Safe metadata for one actual invocation of a durable Workflow Activity.
 * Pass the idempotency key to an external adapter so it can coalesce the
 * at-least-once crash window without treating an invocation as exactly once.
 */
export interface WorkflowActivityAttempt {
  readonly attemptId: string;
  readonly effectRetryNumber: number;
  readonly idempotencyKey: string;
  readonly invocationNumber: number;
}

/**
 * Explicitly chooses whether retries retain the external idempotency identity
 * or receive a new one. The default is always `stable`.
 */
export interface WorkflowActivityRetry {
  readonly idempotency: "stable" | "per-retry";
  /** Number of additional external invocations after the initial attempt. */
  readonly maxRetries: number;
}

export interface WorkflowActivityOptions<
  Success extends Schema.Top,
  Failure extends Schema.Top = typeof Schema.Never,
> {
  /** A developer-chosen identity for this replay-sensitive operation. */
  readonly operationKey: string;
  /** A safe display name; it defaults to the Durable Operation Key. */
  readonly name?: string;
  readonly successSchema: Success;
  readonly failureSchema?: Failure;
  /**
   * The external work. It receives no Workflow input implicitly: close over
   * schema-valid Workflow data deliberately and pass `idempotencyKey` to the
   * external adapter.
   */
  readonly execute: (
    attempt: WorkflowActivityAttempt,
  ) => Effect.Effect<Success["Type"], Failure["Type"]>;
  readonly retry?: WorkflowActivityRetry;
}

export interface WorkflowActivityRuntimeShape {
  readonly execute: <Success extends Schema.Top, Failure extends Schema.Top = typeof Schema.Never>(
    options: WorkflowActivityOptions<Success, Failure>,
  ) => Effect.Effect<Success["Type"], Failure["Type"]>;
}

/**
 * Host-provided durable Activity runtime. It is an implementation detail of a
 * Kojo Workflow Run; authors use `activity` rather than providing this service.
 */
export class WorkflowActivityRuntime extends Context.Service<
  WorkflowActivityRuntime,
  WorkflowActivityRuntimeShape
>()("kojo/workflow/WorkflowActivityRuntime") {}

/** Runs one typed, durable external effect under its Durable Operation Key. */
export const activity = <
  Success extends Schema.Top,
  Failure extends Schema.Top = typeof Schema.Never,
>(
  options: WorkflowActivityOptions<Success, Failure>,
): Effect.Effect<Success["Type"], Failure["Type"]> =>
  Effect.flatMap(WorkflowActivityRuntime, (runtime) => runtime.execute(options)) as Effect.Effect<
    Success["Type"],
    Failure["Type"]
  >;

export interface WorkflowDefinition<
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
> {
  readonly workflowKey: string;
  readonly revision: string;
  readonly inputSchema: Input;
  readonly successSchema: Success;
  readonly failureSchema: Failure;
  readonly sensitivity?: WorkflowSensitivity;
  readonly schedules?: ReadonlyArray<WorkflowSchedule<Input["Type"]>>;
  /** Workflow Keys that this definition may invoke as children. */
  readonly childWorkflowKeys?: ReadonlyArray<string>;
  /**
   * The handler has no unresolved developer-provided services. Authors provide
   * services around the parts of the program that need them before registering it.
   */
  readonly handler: (
    input: Input["Type"],
  ) => Effect.Effect<Success["Type"], Failure["Type"], never>;
}

/** The erased shape used only to collect heterogeneous definitions in one configuration. */
export interface AnyWorkflowDefinition {
  readonly workflowKey: string;
  readonly revision: string;
  readonly inputSchema: Schema.Top;
  readonly successSchema: Schema.Top;
  readonly failureSchema: Schema.Top;
  readonly sensitivity?: WorkflowSensitivity;
  readonly schedules?: ReadonlyArray<WorkflowSchedule<unknown>>;
  readonly childWorkflowKeys?: ReadonlyArray<string>;
  readonly handler: (input: never) => Effect.Effect<unknown, unknown, never>;
}

export interface KojoConfiguration {
  readonly workflows: ReadonlyArray<AnyWorkflowDefinition>;
}

/** Defines one complete, explicitly registered Workflow Definition. */
export const defineWorkflow = <
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
>(
  definition: WorkflowDefinition<Input, Success, Failure>,
): WorkflowDefinition<Input, Success, Failure> => definition;

/** Defines one immutable Workflow Schedule attached to a Workflow Definition. */
export const defineSchedule = <Input>(schedule: WorkflowSchedule<Input>): WorkflowSchedule<Input> =>
  schedule;

export const defineConfig = <const Configuration extends KojoConfiguration>(
  configuration: Configuration,
): Configuration => configuration;
