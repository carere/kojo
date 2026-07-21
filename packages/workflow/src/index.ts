import { Cron, Effect, Schema } from "effect";
import { CompositionRuntime } from "./composition";

export type {
  ActivityRetryBackoffContext,
  ActivityRetryOptions,
  LoopIteration,
  LoopOptions,
} from "./composition";
export { ActivityRetry, Loop } from "./composition";
export type {
  AgentProviderConfiguration,
  AgentProviderService,
  AgentRunOptions,
  CommandExecutionOptions,
  CommandFailure,
  CommandOptions,
  ExecutionArtifactReference,
  ProviderConfiguration,
  SandboxAgentResult,
  SandboxCreateOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxProviderFailure,
  SandboxProviderService,
  SandboxUseOptions,
} from "./sandbox";
export { Agent, AgentProvider, Command, Sandbox, SandboxProvider } from "./sandbox";
export { WorkflowTest } from "./workflow-test";

export const COMPATIBILITY = Object.freeze({
  kojo: "0.1.0",
  workflowAbi: "1",
  effect: "4.0.0-beta.98",
  platformBun: "4.0.0-beta.98",
  bun: "1.3.14",
  typesBun: "1.3.14",
  typescript: "7.0.2",
} as const);

const WorkflowDefinitionTypeId = Symbol("@kojo/workflow/WorkflowDefinition");
const ScheduleDefinitionTypeId = Symbol("@kojo/workflow/ScheduleDefinition");

export interface WorkflowDefinition<
  Name extends string,
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Requirements = never,
> {
  readonly [WorkflowDefinitionTypeId]: typeof WorkflowDefinitionTypeId;
  readonly name: Name;
  readonly version: string;
  readonly entryPoint: string;
  readonly input: Input;
  readonly success: Success;
  readonly failure: Failure;
  readonly recovery: Readonly<
    Record<
      string,
      (failure: Schema.Schema.Type<Failure>) => Effect.Effect<void, never, Requirements>
    >
  >;
  readonly run: {
    (
      input: Schema.Schema.Type<Input>,
    ): Effect.Effect<Schema.Schema.Type<Success>, Schema.Schema.Type<Failure>, Requirements>;
    (
      key: string,
      input: Schema.Schema.Type<Input>,
    ): Effect.Effect<
      Schema.Schema.Type<Success>,
      Schema.Schema.Type<Failure>,
      Requirements | import("effect/unstable/workflow").WorkflowEngine.WorkflowInstance
    >;
  };
}

export interface WorkflowOptions<
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Requirements,
> {
  readonly version: string;
  readonly entryPoint: string;
  readonly input: Input;
  readonly success: Success;
  readonly failure: Failure;
  readonly recovery?: Readonly<
    Record<
      string,
      (failure: Schema.Schema.Type<Failure>) => Effect.Effect<void, never, Requirements>
    >
  >;
  readonly run: (
    input: Schema.Schema.Type<Input>,
  ) => Effect.Effect<Schema.Schema.Type<Success>, Schema.Schema.Type<Failure>, Requirements>;
}

type AnyWorkflow = WorkflowDefinition<string, Schema.Top, Schema.Top, Schema.Top, unknown>;

const makeWorkflow = <
  const Name extends string,
  Input extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top,
  Requirements,
>(
  name: Name,
  options: WorkflowOptions<Input, Success, Failure, Requirements>,
): WorkflowDefinition<Name, Input, Success, Failure, Requirements> => {
  const definition = {
    [WorkflowDefinitionTypeId]: WorkflowDefinitionTypeId,
    name,
    version: options.version,
    entryPoint: options.entryPoint,
    input: options.input,
    success: options.success,
    failure: options.failure,
    recovery: Object.freeze({ ...options.recovery }),
    run: ((...arguments_: [Schema.Schema.Type<Input>] | [string, Schema.Schema.Type<Input>]) =>
      arguments_.length === 1
        ? options.run(arguments_[0] as Schema.Schema.Type<Input>)
        : CompositionRuntime.ChildWorkflowInvoker.pipe(
            Effect.flatMap((invoker) => invoker.invoke(definition, arguments_[0], arguments_[1])),
          )) as WorkflowDefinition<Name, Input, Success, Failure, Requirements>["run"],
  } as WorkflowDefinition<Name, Input, Success, Failure, Requirements>;
  return Object.freeze(definition);
};

export const Workflow = Object.freeze({ make: makeWorkflow });

export type MissedTimePolicy = "skip" | "catch-up-once";

export interface ScheduleDefinition<Name extends string, Definition extends AnyWorkflow> {
  readonly [ScheduleDefinitionTypeId]: typeof ScheduleDefinitionTypeId;
  readonly name: Name;
  readonly workflow: Definition;
  readonly input: Schema.Schema.Type<Definition["input"]>;
  readonly cron: Cron.Cron;
  readonly timezone: string;
  readonly missedTimePolicy: MissedTimePolicy;
}

export interface ScheduleOptions<Definition extends AnyWorkflow> {
  readonly workflow: Definition;
  readonly input: Schema.Schema.Type<Definition["input"]>;
  readonly cron: Cron.Cron;
  readonly timezone: string;
  readonly missedTimePolicy: MissedTimePolicy;
}

type AnySchedule = ScheduleDefinition<string, AnyWorkflow>;

const makeSchedule = <const Name extends string, Definition extends AnyWorkflow>(
  name: Name,
  options: ScheduleOptions<Definition>,
): ScheduleDefinition<Name, Definition> =>
  Object.freeze({
    [ScheduleDefinitionTypeId]: ScheduleDefinitionTypeId,
    name,
    workflow: options.workflow,
    input: options.input,
    cron: options.cron,
    timezone: options.timezone,
    missedTimePolicy: options.missedTimePolicy,
  });

export const Schedule = Object.freeze({ make: makeSchedule });

export type RegistryDiagnosticCode =
  | "InvalidWorkflowRegistry"
  | "InvalidWorkflowDefinition"
  | "InvalidWorkflowName"
  | "DuplicateWorkflowName"
  | "InvalidWorkflowVersion"
  | "InvalidWorkflowEntryPoint"
  | "InvalidWorkflowSchema"
  | "InvalidWorkflowRun"
  | "InvalidWorkflowRecovery"
  | "InvalidScheduleRegistry"
  | "InvalidScheduleDefinition"
  | "InvalidScheduleName"
  | "DuplicateScheduleName"
  | "UnknownScheduleWorkflow"
  | "InvalidScheduleCron"
  | "InvalidScheduleTimezone"
  | "InvalidScheduleMissedTimePolicy"
  | "InvalidScheduleInput";

export interface RegistryDiagnostic {
  readonly code: RegistryDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export class RegistryValidationError extends Error {
  readonly _tag = "RegistryValidationError";

  constructor(readonly diagnostics: ReadonlyArray<RegistryDiagnostic>) {
    super(
      `Invalid Workflow Registry:\n${diagnostics
        .map((diagnostic) => `- ${diagnostic.path}: ${diagnostic.message}`)
        .join("\n")}`,
    );
    this.name = "RegistryValidationError";
  }
}

export interface KojoConfig<
  Workflows extends ReadonlyArray<AnyWorkflow>,
  Schedules extends ReadonlyArray<AnySchedule>,
> {
  readonly workflows: Workflows;
  readonly schedules: Schedules;
}

export interface ConfigInput<
  Workflows extends ReadonlyArray<AnyWorkflow>,
  Schedules extends ReadonlyArray<AnySchedule>,
> {
  readonly workflows: Workflows;
  readonly schedules?: Schedules;
}

const schemeOrDrivePattern = /^[a-z][a-z\d+.-]*:/i;
const declarationFilePattern = /\.d\.(?:ts|mts)$/;

const isRepositoryEntryPoint = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    schemeOrDrivePattern.test(value) ||
    declarationFilePattern.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return (
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    /\.(?:ts|mts)$/.test(segments.at(-1) ?? "")
  );
};

const isStableName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isWorkflow = (value: unknown): value is AnyWorkflow =>
  typeof value === "object" &&
  value !== null &&
  WorkflowDefinitionTypeId in value &&
  value[WorkflowDefinitionTypeId] === WorkflowDefinitionTypeId;

const isSchedule = (value: unknown): value is AnySchedule =>
  typeof value === "object" &&
  value !== null &&
  ScheduleDefinitionTypeId in value &&
  value[ScheduleDefinitionTypeId] === ScheduleDefinitionTypeId;

const diagnostic = (
  diagnostics: Array<RegistryDiagnostic>,
  code: RegistryDiagnosticCode,
  path: string,
  message: string,
) => diagnostics.push({ code, path, message });

const validateWorkflow = (
  value: unknown,
  index: number,
  diagnostics: Array<RegistryDiagnostic>,
): value is AnyWorkflow => {
  const path = `workflows[${index}]`;
  if (!isWorkflow(value)) {
    diagnostic(
      diagnostics,
      "InvalidWorkflowDefinition",
      path,
      "Expected a Developer Workflow created with Workflow.make.",
    );
    return false;
  }

  if (!isStableName(value.name)) {
    diagnostic(
      diagnostics,
      "InvalidWorkflowName",
      `${path}.name`,
      "Expected a non-empty case-sensitive stable name.",
    );
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    diagnostic(
      diagnostics,
      "InvalidWorkflowVersion",
      `${path}.version`,
      "Expected a non-empty opaque declared version.",
    );
  }
  if (!isRepositoryEntryPoint(value.entryPoint)) {
    diagnostic(
      diagnostics,
      "InvalidWorkflowEntryPoint",
      `${path}.entryPoint`,
      "Expected a repository-relative ESM TypeScript entry point.",
    );
  }
  for (const field of ["input", "success", "failure"] as const) {
    if (!Schema.isSchema(value[field])) {
      diagnostic(
        diagnostics,
        "InvalidWorkflowSchema",
        `${path}.${field}`,
        `Expected ${field} to be an Effect Schema.`,
      );
    }
  }
  if (typeof value.run !== "function") {
    diagnostic(
      diagnostics,
      "InvalidWorkflowRun",
      `${path}.run`,
      "Expected an Effect-returning run function.",
    );
  }
  for (const [tag, handler] of Object.entries(value.recovery)) {
    if (tag.length === 0 || typeof handler !== "function") {
      diagnostic(
        diagnostics,
        "InvalidWorkflowRecovery",
        `${path}.recovery`,
        "Expected non-empty stable failure tags mapped to Effect-returning Recovery Handlers.",
      );
      break;
    }
  }
  return true;
};

const validTimeZone = (timezone: string): boolean => {
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions()
      .timeZone;
    return !/^[+-]\d{2}:\d{2}$/.test(resolved);
  } catch {
    return false;
  }
};

export const defineConfig = <
  const Workflows extends ReadonlyArray<AnyWorkflow>,
  const Schedules extends ReadonlyArray<AnySchedule> = readonly [],
>(
  input: ConfigInput<Workflows, Schedules>,
): KojoConfig<Workflows, Schedules> => {
  const diagnostics: Array<RegistryDiagnostic> = [];
  const workflowNames = new Map<string, number>();
  const validWorkflows = new Set<AnyWorkflow>();
  const workflows: ReadonlyArray<unknown> = Array.isArray(input?.workflows) ? input.workflows : [];

  if (!Array.isArray(input?.workflows)) {
    diagnostic(
      diagnostics,
      "InvalidWorkflowRegistry",
      "workflows",
      "Expected workflows to be an array of explicitly imported Developer Workflows.",
    );
  }

  for (const [index, workflow] of workflows.entries()) {
    if (!validateWorkflow(workflow, index, diagnostics)) continue;
    validWorkflows.add(workflow);
    const previous = workflowNames.get(workflow.name);
    if (previous !== undefined) {
      diagnostic(
        diagnostics,
        "DuplicateWorkflowName",
        `workflows[${index}].name`,
        `Developer Workflow name '${workflow.name}' duplicates workflows[${previous}].name.`,
      );
    } else {
      workflowNames.set(workflow.name, index);
    }
  }

  const schedulesValue = input?.schedules === undefined ? [] : input.schedules;
  const schedules: ReadonlyArray<unknown> = Array.isArray(schedulesValue) ? schedulesValue : [];

  if (!Array.isArray(schedulesValue)) {
    diagnostic(
      diagnostics,
      "InvalidScheduleRegistry",
      "schedules",
      "Expected schedules to be an array of explicitly imported Workflow Schedules.",
    );
  }

  const scheduleNames = new Map<string, number>();
  for (const [index, schedule] of schedules.entries()) {
    const path = `schedules[${index}]`;
    if (!isSchedule(schedule)) {
      diagnostic(
        diagnostics,
        "InvalidScheduleDefinition",
        path,
        "Expected a Workflow Schedule created with Schedule.make.",
      );
      continue;
    }
    if (!isStableName(schedule.name)) {
      diagnostic(
        diagnostics,
        "InvalidScheduleName",
        `${path}.name`,
        "Expected a non-empty case-sensitive stable name.",
      );
    }
    const previous = scheduleNames.get(schedule.name);
    if (previous !== undefined) {
      diagnostic(
        diagnostics,
        "DuplicateScheduleName",
        `${path}.name`,
        `Workflow Schedule name '${schedule.name}' duplicates schedules[${previous}].name.`,
      );
    } else {
      scheduleNames.set(schedule.name, index);
    }
    if (!validWorkflows.has(schedule.workflow)) {
      diagnostic(
        diagnostics,
        "UnknownScheduleWorkflow",
        `${path}.workflow`,
        "Expected the targeted Developer Workflow to be present in workflows.",
      );
    }
    if (
      !Cron.isCron(schedule.cron) ||
      !schedule.cron.seconds.has(0) ||
      schedule.cron.seconds.size !== 1
    ) {
      diagnostic(
        diagnostics,
        "InvalidScheduleCron",
        `${path}.cron`,
        "Expected an Effect Cron value with minute precision.",
      );
    }
    if (typeof schedule.timezone !== "string" || !validTimeZone(schedule.timezone)) {
      diagnostic(
        diagnostics,
        "InvalidScheduleTimezone",
        `${path}.timezone`,
        "Expected a valid IANA timezone.",
      );
    }
    if (schedule.missedTimePolicy !== "skip" && schedule.missedTimePolicy !== "catch-up-once") {
      diagnostic(
        diagnostics,
        "InvalidScheduleMissedTimePolicy",
        `${path}.missedTimePolicy`,
        "Expected missedTimePolicy to be 'skip' or 'catch-up-once'.",
      );
    }
    if (validWorkflows.has(schedule.workflow) && Schema.isSchema(schedule.workflow.input)) {
      try {
        Schema.decodeUnknownSync(
          Schema.toType(schedule.workflow.input) as unknown as Schema.ConstraintDecoder<unknown>,
        )(schedule.input);
      } catch {
        diagnostic(
          diagnostics,
          "InvalidScheduleInput",
          `${path}.input`,
          `Input does not match Developer Workflow '${schedule.workflow.name}'.`,
        );
      }
    }
  }

  if (diagnostics.length > 0) {
    throw new RegistryValidationError(Object.freeze(diagnostics));
  }

  return Object.freeze({
    workflows: Object.freeze([...workflows]) as unknown as Workflows,
    schedules: Object.freeze([...schedules]) as unknown as Schedules,
  });
};
