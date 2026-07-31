import { Context, type Duration, Effect, Schema } from "effect";

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
  /**
   * An immutable operation-definition identity used by Kojo-owned wrappers
   * such as Sandboxes and Commands to reject conflicting key reuse.
   */
  readonly definitionIdentity?: string;
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

export type SandboxProviderKind = "docker" | "podman" | "vercel" | "daytona" | "unsafe-host";

/**
 * A credential-free, versioned description of a Sandbox Provider. Provider
 * credentials belong to the Host environment and are resolved only when work
 * is invoked.
 */
export interface BuiltInSandboxProvider {
  readonly kind: SandboxProviderKind;
  readonly providerKey: string;
  readonly revision: string;
  /** Host execution has no isolation and must be acknowledged explicitly. */
  readonly unsafeAcknowledged?: true;
}

/** A custom Provider runs through the same Host-owned ProviderRuntime seam. */
export interface CustomSandboxProvider {
  readonly kind: "custom";
  readonly providerKey: string;
  readonly revision: string;
  /** Declare this only when the provider can prove Agent Session continuation. */
  readonly supportsAgentSessionContinuation?: true;
  readonly acquire?: (
    input: CustomSandboxAcquireInput,
  ) => Effect.Effect<void, SandboxProviderFailure>;
  readonly runCommand: (
    input: CustomSandboxCommandInput,
  ) => Effect.Effect<CommandExecutionResult, SandboxProviderFailure>;
}

export type SandboxProvider = BuiltInSandboxProvider | CustomSandboxProvider;

export interface SandboxProviderFailure {
  readonly _tag: "sandbox-provider-failure";
  readonly message: string;
}

export const SandboxProviderFailure = Schema.Struct({
  _tag: Schema.Literal("sandbox-provider-failure"),
  message: Schema.String,
});

/** The safe context a custom provider receives; it deliberately has no handle. */
export interface CustomSandboxAcquireInput {
  readonly image: SandboxImageDefinition | undefined;
  readonly sandbox: AcquiredWorkflowSandbox;
}

/** The safe context a custom provider receives for one command invocation. */
export interface CustomSandboxCommandInput extends CustomSandboxAcquireInput {
  readonly command: Command;
}

/**
 * An immutable image description. `source` is version-controlled definition
 * data, never a credential-bearing provider configuration.
 */
export interface SandboxImageDefinition {
  readonly imageKey: string;
  readonly revision: string;
  readonly source: {
    readonly kind: "container-image";
    readonly reference: string;
  };
}

/** A versioned logical environment selected by workflow code. */
export interface WorkflowSandboxDefinition {
  readonly sandboxKey: string;
  readonly revision: string;
  readonly provider: SandboxProvider;
  readonly image?: SandboxImageDefinition;
}

/**
 * The durable, logical Sandbox returned by {@link Sandbox.acquire}. The
 * identity is scoped to one Workflow Run and is not a provider session handle.
 */
export interface AcquiredWorkflowSandbox {
  readonly _tag: "workflow-sandbox";
  readonly identity: string;
  readonly operationKey: string;
  readonly providerKind: SandboxProvider["kind"];
  readonly providerKey: string;
  readonly providerRevision: string;
  readonly sandboxKey: string;
  readonly revision: string;
  readonly imageKey?: string;
  readonly imageRevision?: string;
}

export const AcquiredWorkflowSandbox = Schema.Struct({
  _tag: Schema.Literal("workflow-sandbox"),
  identity: Schema.String,
  operationKey: Schema.String,
  providerKind: Schema.Literals(["docker", "podman", "vercel", "daytona", "unsafe-host", "custom"]),
  providerKey: Schema.String,
  providerRevision: Schema.String,
  sandboxKey: Schema.String,
  revision: Schema.String,
  imageKey: Schema.optionalKey(Schema.String),
  imageRevision: Schema.optionalKey(Schema.String),
});

export type AgentProviderKind =
  | "codex"
  | "claude-code"
  | "pi"
  | "cursor"
  | "opencode"
  | "github-copilot";

/**
 * A credential-free, versioned description of one built-in coding Agent.
 *
 * The Host resolves the provider's local credential only when it invokes the
 * Agent. Definitions must never contain credentials or session material.
 */
export interface BuiltInAgentProvider {
  readonly kind: AgentProviderKind;
  readonly providerKey: string;
  readonly revision: string;
  readonly model: string;
}

/**
 * The safe input a custom Agent Provider receives. The logical Workflow
 * Sandbox intentionally contains no live provider handle.
 */
export interface CustomAgentRunInput {
  readonly idempotencyKey: string;
  readonly prompt: string;
  readonly sandbox: AcquiredWorkflowSandbox;
  readonly session?: AgentSession;
}

/** A custom Agent may require Effect services that its author provided. */
export interface CustomAgentProvider {
  readonly kind: "custom";
  readonly providerKey: string;
  readonly revision: string;
  /** Declare this only when the provider can prove session continuation. */
  readonly supportsSessionContinuation?: true;
  readonly run: (
    input: CustomAgentRunInput,
  ) => Effect.Effect<AgentProviderResult, AgentProviderFailure>;
}

export type AgentProvider = BuiltInAgentProvider | CustomAgentProvider;

export interface AgentProviderFailure {
  readonly _tag: "agent-provider-failure";
  readonly message: string;
}

export const AgentProviderFailure = Schema.Struct({
  _tag: Schema.Literal("agent-provider-failure"),
  message: Schema.String,
});

/** Optional token usage reported by a coding Agent Provider. */
export interface AgentUsage {
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const AgentUsage = Schema.Struct({
  cacheCreationInputTokens: Schema.Number,
  cacheReadInputTokens: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
});

/**
 * A provider-native session reference. It is a protected continuation
 * capability, not a Workflow Run resume token or a provider handle.
 */
export interface AgentSession {
  readonly _tag: "agent-session";
  readonly providerKey: string;
  readonly providerKind: AgentProvider["kind"];
  readonly providerRevision: string;
  readonly sandboxIdentity: string;
  readonly sessionId: string;
}

export const AgentSession = Schema.Struct({
  _tag: Schema.Literal("agent-session"),
  providerKey: Schema.String,
  providerKind: Schema.Literals([
    "codex",
    "claude-code",
    "pi",
    "cursor",
    "opencode",
    "github-copilot",
    "custom",
  ]),
  providerRevision: Schema.String,
  sandboxIdentity: Schema.String,
  sessionId: Schema.String,
});

/** The normalized result returned by an Agent Activity. */
export interface AgentResult {
  readonly artifactIds: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<{ readonly sha: string }>;
  readonly sandboxIdentity: string;
  /** The authoritative completed Activity result. */
  readonly text: string;
  readonly usage?: AgentUsage;
  readonly session?: AgentSession;
}

export const AgentResult = Schema.Struct({
  artifactIds: Schema.Array(Schema.String),
  commits: Schema.Array(Schema.Struct({ sha: Schema.String })),
  sandboxIdentity: Schema.String,
  text: Schema.String,
  usage: Schema.optionalKey(AgentUsage),
  session: Schema.optionalKey(AgentSession),
});

/** The provider-level outcome before Kojo records an Artifact or Session. */
export interface AgentProviderResult {
  readonly commits: ReadonlyArray<{ readonly sha: string }>;
  readonly sessionId?: string;
  readonly text: string;
  readonly usage?: AgentUsage;
}

export interface AgentFailure {
  readonly _tag:
    | "agent-provider-failure"
    | "agent-session-continuation-unsupported"
    | "agent-timed-out";
  readonly message: string;
  readonly sandboxIdentity: string;
}

export const AgentFailure = Schema.Struct({
  _tag: Schema.Literals([
    "agent-provider-failure",
    "agent-session-continuation-unsupported",
    "agent-timed-out",
  ]),
  message: Schema.String,
  sandboxIdentity: Schema.String,
});

export interface WorkflowAgentRuntimeShape {
  readonly run: (options: {
    readonly agent: AgentProvider;
    readonly operationKey: string;
    readonly prompt: string;
    readonly sandbox: AcquiredWorkflowSandbox;
    readonly session?: AgentSession;
    readonly timeout?: Duration.Input;
  }) => Effect.Effect<AgentResult, AgentFailure>;
}

/** Host-provided runtime for durable Agent Activities. */
export class WorkflowAgentRuntime extends Context.Service<
  WorkflowAgentRuntime,
  WorkflowAgentRuntimeShape
>()("kojo/workflow/WorkflowAgentRuntime") {}

export interface Command {
  readonly commandKey: string;
  readonly revision: string;
  /** An argument vector. Kojo never requires authors to pre-concatenate it. */
  readonly arguments: ReadonlyArray<string>;
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeout?: Duration.Input;
  /** Default `none` quotes the argument vector; `sh` deliberately invokes a shell. */
  readonly shell?: "none" | "sh";
  /** Default `fail` turns a non-zero exit into a typed failure. */
  readonly nonZeroExit?: "fail" | "return";
}

export interface CommandExecutionResult {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CommandResult extends CommandExecutionResult {
  readonly artifactIds: ReadonlyArray<string>;
  readonly sandboxIdentity: string;
}

export const CommandResult = Schema.Struct({
  artifactIds: Schema.Array(Schema.String),
  durationMs: Schema.Number,
  exitCode: Schema.Number,
  sandboxIdentity: Schema.String,
  stderr: Schema.String,
  stdout: Schema.String,
});

export interface CommandFailure {
  readonly _tag: "command-failed" | "command-timed-out" | "sandbox-provider-failure";
  readonly exitCode?: number;
  readonly message: string;
  readonly sandboxIdentity: string;
}

export const CommandFailure = Schema.Struct({
  _tag: Schema.Literals(["command-failed", "command-timed-out", "sandbox-provider-failure"]),
  exitCode: Schema.optionalKey(Schema.Number),
  message: Schema.String,
  sandboxIdentity: Schema.String,
});

export interface WorkflowSandboxRuntimeShape {
  readonly acquire: (options: {
    readonly operationKey: string;
    readonly sandbox: WorkflowSandboxDefinition;
  }) => Effect.Effect<AcquiredWorkflowSandbox, SandboxProviderFailure>;
}

/** Host-provided runtime that owns all live Sandbox Provider handles. */
export class WorkflowSandboxRuntime extends Context.Service<
  WorkflowSandboxRuntime,
  WorkflowSandboxRuntimeShape
>()("kojo/workflow/WorkflowSandboxRuntime") {}

export interface WorkflowCommandRuntimeShape {
  readonly run: (options: {
    readonly command: Command;
    readonly operationKey: string;
    readonly sandbox: AcquiredWorkflowSandbox;
  }) => Effect.Effect<CommandResult, CommandFailure>;
}

/** Host-provided command runtime. Commands receive a logical Sandbox only. */
export class WorkflowCommandRuntime extends Context.Service<
  WorkflowCommandRuntime,
  WorkflowCommandRuntimeShape
>()("kojo/workflow/WorkflowCommandRuntime") {}

/** Durable operations for logical Workflow Sandboxes. */
export const Sandbox = {
  acquire: (options: {
    readonly operationKey: string;
    readonly sandbox: WorkflowSandboxDefinition;
  }) => Effect.flatMap(WorkflowSandboxRuntime, (runtime) => runtime.acquire(options)),
};

/** Durable Command execution inside an acquired logical Workflow Sandbox. */
export const Command = {
  run: (options: {
    readonly command: Command;
    readonly operationKey: string;
    readonly sandbox: AcquiredWorkflowSandbox;
  }) => Effect.flatMap(WorkflowCommandRuntime, (runtime) => runtime.run(options)),
};

/** Runs one coding Agent as a durable Workflow Activity. */
export const Agent = {
  run: (options: {
    readonly agent: AgentProvider;
    readonly operationKey: string;
    readonly prompt: string;
    readonly sandbox: AcquiredWorkflowSandbox;
    readonly session?: AgentSession;
    readonly timeout?: Duration.Input;
  }) => Effect.flatMap(WorkflowAgentRuntime, (runtime) => runtime.run(options)),
};

const validDefinitionPart = (value: string) => value.trim().length > 0 && value.length <= 200;

const immutable = <Value>(value: Value): Value => {
  if (Array.isArray(value)) {
    for (const item of value) immutable(item);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) immutable(item);
  }
  return Object.freeze(value);
};

const assertDefinitionPart = (value: string, name: string) => {
  if (!validDefinitionPart(value)) {
    throw new Error(`${name} must contain from 1 to 200 non-whitespace characters.`);
  }
};

/** Creates an immutable built-in Provider value without credential fields. */
export const defineBuiltInSandboxProvider = (
  provider: BuiltInSandboxProvider,
): BuiltInSandboxProvider => {
  assertDefinitionPart(provider.providerKey, "Sandbox Provider Key");
  assertDefinitionPart(provider.revision, "Sandbox Provider Revision");
  if (provider.kind === "unsafe-host" && provider.unsafeAcknowledged !== true) {
    throw new Error("Unsafe host execution requires unsafeAcknowledged: true.");
  }
  if (provider.kind !== "unsafe-host" && provider.unsafeAcknowledged !== undefined) {
    throw new Error("Only the unsafe-host Provider may acknowledge host execution.");
  }
  return immutable({ ...provider });
};

/** Creates an immutable custom Provider value with its Host-facing operations. */
export const defineCustomSandboxProvider = (
  provider: CustomSandboxProvider,
): CustomSandboxProvider => {
  assertDefinitionPart(provider.providerKey, "Sandbox Provider Key");
  assertDefinitionPart(provider.revision, "Sandbox Provider Revision");
  return immutable({ ...provider });
};

/** Creates an immutable built-in Agent Provider without credential fields. */
export const defineBuiltInAgentProvider = (
  provider: BuiltInAgentProvider,
): BuiltInAgentProvider => {
  assertDefinitionPart(provider.providerKey, "Agent Provider Key");
  assertDefinitionPart(provider.revision, "Agent Provider Revision");
  assertDefinitionPart(provider.model, "Agent Model");
  return immutable({ ...provider });
};

/** Creates an immutable custom Agent Provider with its Host-facing operation. */
export const defineCustomAgentProvider = (provider: CustomAgentProvider): CustomAgentProvider => {
  assertDefinitionPart(provider.providerKey, "Agent Provider Key");
  assertDefinitionPart(provider.revision, "Agent Provider Revision");
  return immutable({ ...provider });
};

/** Creates an immutable, credential-free Sandbox Image Definition. */
export const defineSandboxImage = (image: SandboxImageDefinition): SandboxImageDefinition => {
  assertDefinitionPart(image.imageKey, "Sandbox Image Key");
  assertDefinitionPart(image.revision, "Sandbox Image Revision");
  if (image.source.reference.trim().length === 0) {
    throw new Error("Sandbox Image source reference must not be empty.");
  }
  return immutable({ ...image, source: { ...image.source } });
};

/** Creates an immutable logical Workflow Sandbox definition. */
export const defineSandbox = (sandbox: WorkflowSandboxDefinition): WorkflowSandboxDefinition => {
  assertDefinitionPart(sandbox.sandboxKey, "Workflow Sandbox Key");
  assertDefinitionPart(sandbox.revision, "Workflow Sandbox Revision");
  return immutable({ ...sandbox });
};

/** Creates an immutable Command value with an explicit argument vector. */
export const defineCommand = (command: Command): Command => {
  assertDefinitionPart(command.commandKey, "Command Key");
  assertDefinitionPart(command.revision, "Command Revision");
  if (
    command.arguments.length === 0 ||
    command.arguments.some((argument) => argument.length === 0)
  ) {
    throw new Error(
      "Command arguments must contain a non-empty executable and no empty arguments.",
    );
  }
  return immutable({
    ...command,
    arguments: [...command.arguments],
    ...(command.environment === undefined ? {} : { environment: { ...command.environment } }),
  });
};

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
