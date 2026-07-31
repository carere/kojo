import { Context, Effect, Schema } from "effect";

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

export const defineConfig = <const Configuration extends KojoConfiguration>(
  configuration: Configuration,
): Configuration => configuration;
