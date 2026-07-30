import { type Effect, Schema } from "effect";

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
 * Paths in a value schema that contain sensitive values. Paths use dot notation;
 * an empty array means that the corresponding value contains no marked fields.
 */
export interface WorkflowSensitivity {
  readonly input?: ReadonlyArray<string>;
  readonly success?: ReadonlyArray<string>;
  readonly failure?: ReadonlyArray<string>;
}

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
