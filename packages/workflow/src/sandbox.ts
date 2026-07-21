import { createHash } from "node:crypto";
import { Cause, Context, Effect, Layer, Redacted, Schema } from "effect";
import { Activity } from "effect/unstable/workflow";
import { ActivityRetry, type ActivityRetryOptions, CompositionRuntime } from "./composition";

export interface ProviderConfiguration {
  readonly adapterVersion: string;
  readonly configurationFingerprint: string;
  readonly name: string;
  readonly publicFields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AgentProviderConfiguration extends ProviderConfiguration {
  readonly model: string;
}

export interface SandboxCreateOptions {
  readonly baseBranch?: string;
  readonly branch: string;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface SandboxAgentResult {
  readonly commits: ReadonlyArray<{ readonly sha: string }>;
  readonly output?: unknown;
  readonly stdout: string;
}

export interface SandboxHandle {
  readonly branch: string;
  readonly close: () => Promise<{ readonly preservedWorktreePath?: string }>;
  readonly exec: (command: string, options?: CommandExecutionOptions) => Promise<SandboxExecResult>;
  readonly run: (options: {
    readonly agent: unknown;
    readonly logging: { readonly type: "stdout"; readonly verbose: false };
    readonly maxIterations?: number;
    readonly prompt: string;
  }) => Promise<SandboxAgentResult>;
}

export interface SandboxProviderService {
  readonly configuration: ProviderConfiguration;
  readonly create: (
    options: SandboxCreateOptions,
  ) => Effect.Effect<SandboxHandle, SandboxProviderFailure>;
}

export const SandboxProviderFailure = Schema.TaggedStruct("Sandbox.ProviderFailure", {
  message: Schema.String,
});
export type SandboxProviderFailure = Schema.Schema.Type<typeof SandboxProviderFailure>;

export interface AgentProviderService {
  readonly agent: unknown;
  readonly configuration: AgentProviderConfiguration;
  readonly redact?: (value: string) => string;
}

export interface AgentProviderLayerOptions<E, R> {
  readonly configuration: AgentProviderConfiguration;
  readonly makeAgent: (secrets: ReadonlyArray<string>) => unknown;
  readonly secrets: Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, E, R>;
}

export const SandboxProvider = Context.Service<SandboxProviderService>(
  "@kojo/workflow/SandboxProvider",
);

const AgentProviderService = Context.Service<AgentProviderService>("@kojo/workflow/AgentProvider");

export const AgentProvider = Object.assign(AgentProviderService, {
  layer: <E, R>(options: AgentProviderLayerOptions<E, R>) =>
    Layer.effect(
      AgentProviderService,
      options.secrets.pipe(
        Effect.map((redactedValues) => {
          // Sandcastle accepts plain strings. Keep this one unwrap adjacent to
          // constructing the process-local agent. The redactor closes over those
          // values without exposing them as provider service data.
          const secrets = redactedValues.map(Redacted.value);
          return {
            agent: options.makeAgent(secrets),
            configuration: options.configuration,
            redact: (value: string) =>
              secrets.reduce(
                (text, secret) =>
                  secret.length === 0 ? text : text.split(secret).join("[REDACTED]"),
                value,
              ),
          };
        }),
      ),
    ),
});

interface CurrentSandboxService {
  readonly handle: SandboxHandle;
  readonly name: string;
}

const CurrentSandbox = Context.Service<CurrentSandboxService>("@kojo/workflow/CurrentSandbox");

export interface ExecutionArtifactReference {
  readonly byteLength: number;
  readonly fingerprint: string;
  readonly mediaType: string;
  readonly name: string;
}

interface ExecutionArtifactRecorderService {
  readonly finalizeText: (
    name: string,
    content: string,
  ) => Effect.Effect<ExecutionArtifactReference>;
}

const ExecutionArtifactRecorder = Context.Reference<ExecutionArtifactRecorderService>(
  "@kojo/workflow/ExecutionArtifactRecorder",
  {
    defaultValue: () => ({
      finalizeText: (name, content) => Effect.sync(() => outputArtifact(name, content)),
    }),
  },
);

const stableName = (name: string) => name.length > 0 && name === name.trim();

const assertProviderConfiguration = (configuration: ProviderConfiguration) => {
  if (
    !stableName(configuration.name) ||
    !stableName(configuration.adapterVersion) ||
    !stableName(configuration.configurationFingerprint)
  ) {
    throw new Error("Provider metadata requires a stable name, adapter version, and fingerprint");
  }
  for (const value of Object.values(configuration.publicFields)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error("Provider public fields must contain only explicitly safe scalar values");
    }
  }
  JSON.stringify(configuration.publicFields);
};

const providerSnapshot = (
  kind: "Agent" | "Sandbox",
  configuration: ProviderConfiguration | AgentProviderConfiguration,
) => ({
  adapterVersion: configuration.adapterVersion,
  configurationFingerprint: configuration.configurationFingerprint,
  kind,
  ...(kind === "Agent" ? { model: (configuration as AgentProviderConfiguration).model } : {}),
  name: configuration.name,
  publicFields: configuration.publicFields,
});

const verifyConfiguration = (
  subject: string,
  kind: "Agent" | "Sandbox",
  configuration: ProviderConfiguration | AgentProviderConfiguration,
) =>
  Effect.gen(function* () {
    assertProviderConfiguration(configuration);
    if (kind === "Agent" && !stableName((configuration as AgentProviderConfiguration).model)) {
      return yield* Effect.die("Agent Provider metadata requires a non-empty stable model");
    }
    yield* CompositionRuntime.RuntimeConfigurationRecorder.pipe(
      Effect.flatMap((recorder) => recorder.verify(subject, providerSnapshot(kind, configuration))),
    );
  });

const record = (boundary: {
  readonly details?: unknown;
  readonly idempotencyKey: string;
  readonly subject: string;
  readonly type: string;
}) =>
  CompositionRuntime.BoundaryRecorder.pipe(Effect.flatMap((recorder) => recorder.record(boundary)));

export interface SandboxUseOptions<A, E, R> extends SandboxCreateOptions {
  readonly effect: Effect.Effect<A, E, R>;
}

const useSandbox = <A, E, R>(
  name: string,
  options: SandboxUseOptions<A, E, R>,
): Effect.Effect<A, E | SandboxProviderFailure, R | SandboxProviderService> =>
  Effect.gen(function* () {
    if (!stableName(name)) return yield* Effect.die("Sandbox.use requires a non-empty stable name");
    if (!stableName(options.branch)) {
      return yield* Effect.die("Sandbox.use requires a non-empty stable branch");
    }
    const path = yield* CompositionRuntime.DurablePath;
    const executionAttempt = yield* CompositionRuntime.ExecutionAttempt;
    const subject = [...path, name].join("/");
    const provider = yield* SandboxProvider;
    yield* verifyConfiguration(subject, "Sandbox", provider.configuration);
    const acquire = provider
      .create({
        branch: options.branch,
        ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
      })
      .pipe(
        Effect.tapError((failure) =>
          record({
            details: failure,
            idempotencyKey: `sandbox:${subject}:${executionAttempt}:open-failed`,
            subject,
            type: "Sandbox.OpenFailed",
          }),
        ),
      );
    const release = (handle: SandboxHandle) =>
      Effect.promise(() => handle.close()).pipe(
        Effect.flatMap((outcome) =>
          record({
            details:
              outcome.preservedWorktreePath === undefined
                ? { branch: options.branch }
                : {
                    branch: options.branch,
                    preservedWorktreePath: outcome.preservedWorktreePath,
                  },
            idempotencyKey: `sandbox:${subject}:${executionAttempt}:cleanup`,
            subject,
            type:
              outcome.preservedWorktreePath === undefined
                ? "Sandbox.Cleaned"
                : "Sandbox.DirtyWorkRetained",
          }),
        ),
        Effect.catchCause((cause) =>
          record({
            details: {
              branch: options.branch,
              cause: Cause.pretty(cause),
              hardCrashOrphansMayRemain: true,
            },
            idempotencyKey: `sandbox:${subject}:${executionAttempt}:cleanup-failed`,
            subject,
            type: "Sandbox.CleanupFailed",
          }).pipe(Effect.catchCause(() => Effect.void)),
        ),
      );
    return yield* Effect.acquireUseRelease(
      acquire,
      (handle) =>
        record({
          details: {
            adapterVersion: provider.configuration.adapterVersion,
            branch: options.branch,
            durabilityGuarantee: "CommittedGitWorkOnly",
            hardCrashOrphanCleanupGuaranteed: false,
            name: provider.configuration.name,
          },
          idempotencyKey: `sandbox:${subject}:${executionAttempt}:opened`,
          subject,
          type: "Sandbox.Opened",
        }).pipe(
          Effect.andThen(
            options.effect.pipe(
              Effect.provideService(CurrentSandbox, { handle, name }),
              Effect.provideService(CompositionRuntime.DurablePath, [...path, name]),
            ),
          ),
        ),
      release,
    );
  }) as Effect.Effect<A, E | SandboxProviderFailure, R | SandboxProviderService>;

export interface CommandExecutionOptions {
  readonly cwd?: string;
  readonly stdin?: string;
  readonly sudo?: boolean;
}

export interface CommandOptions extends CommandExecutionOptions {
  readonly command: string;
  readonly retry?: ActivityRetryOptions<CommandFailure>;
}

export const CommandResult = Schema.Struct({
  exitCode: Schema.Int,
  stderr: Schema.String,
  stdout: Schema.String,
});

export const CommandFailure = Schema.TaggedStruct("Command.ExecutionFailed", {
  message: Schema.String,
});
export type CommandFailure = Schema.Schema.Type<typeof CommandFailure>;

const outputArtifact = (name: string, content: string): ExecutionArtifactReference => ({
  byteLength: new TextEncoder().encode(content).byteLength,
  fingerprint: createHash("sha256").update(content).digest("hex"),
  mediaType: "text/plain; charset=utf-8",
  name,
});

const runCommand = (name: string, options: CommandOptions) => {
  if (!stableName(name)) return Effect.die("Command.run requires a non-empty stable name");
  return Effect.gen(function* () {
    const sandbox = yield* CurrentSandbox;
    const subject = yield* CompositionRuntime.activitySubject(name);
    const activity = Activity.make({
      error: CommandFailure,
      execute: Effect.promise(() =>
        sandbox.handle.exec(options.command, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
          ...(options.sudo === undefined ? {} : { sudo: options.sudo }),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.fail({
            _tag: "Command.ExecutionFailed" as const,
            message: Cause.pretty(cause),
          }),
        ),
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(CommandResult)(result).pipe(Effect.orDie),
        ),
      ),
      name,
      success: CommandResult,
    });
    const result = yield* options.retry === undefined
      ? activity
      : ActivityRetry.run(activity, options.retry);
    const artifacts = yield* Effect.all([
      ExecutionArtifactRecorder.pipe(
        Effect.flatMap((recorder) => recorder.finalizeText("stdout", result.stdout)),
      ),
      ExecutionArtifactRecorder.pipe(
        Effect.flatMap((recorder) => recorder.finalizeText("stderr", result.stderr)),
      ),
    ]);
    yield* record({
      details: {
        artifacts,
        command: options.command,
        exitCode: result.exitCode,
      },
      idempotencyKey: `command:${subject}:output-artifacts`,
      subject,
      type: "Command.OutputArtifactsRecorded",
    });
    return result;
  });
};

export interface AgentRunOptions<Success extends Schema.Top, Failure extends Schema.Top> {
  readonly failure: Failure;
  readonly maxIterations?: number;
  readonly prompt: string;
  readonly success: Success;
}

const AgentTransportResult = Schema.Struct({
  commits: Schema.Array(Schema.Struct({ sha: Schema.String })),
  output: Schema.optional(Schema.Unknown),
  stdout: Schema.String,
});

export const AgentProviderFailure = Schema.TaggedStruct("Agent.ProviderFailure", {
  message: Schema.String,
});
export type AgentProviderFailure = Schema.Schema.Type<typeof AgentProviderFailure>;

const safeProviderIdentity = (configuration: AgentProviderConfiguration) => ({
  adapterVersion: configuration.adapterVersion,
  model: configuration.model,
  name: configuration.name,
});

const agentOutputTag = "kojo-agent-output";

const structuredAgentPrompt = (prompt: string) => `${prompt}

Return the structured Agent Step result as one JSON object wrapped in
<${agentOutputTag}> and </${agentOutputTag}>. Use
{"_tag":"Success","value":...} for success or
{"_tag":"Failure","failure":...} for a typed failure.`;

const outputFromTranscript = (stdout: string) => {
  const closingTag = `</${agentOutputTag}>`;
  const closingIndex = stdout.lastIndexOf(closingTag);
  const openingTag = `<${agentOutputTag}>`;
  const openingIndex =
    closingIndex === -1 ? -1 : stdout.lastIndexOf(openingTag, closingIndex - openingTag.length);
  if (openingIndex === -1 || closingIndex === -1) {
    return Effect.fail({
      _tag: "Agent.ProviderFailure" as const,
      message: "The Agent Provider did not return a structured Agent Step result",
    });
  }
  return Effect.try({
    try: () => JSON.parse(stdout.slice(openingIndex + openingTag.length, closingIndex)),
    catch: () => ({
      _tag: "Agent.ProviderFailure" as const,
      message: "The Agent Provider returned invalid structured JSON",
    }),
  });
};

const redact = (value: string, provider: AgentProviderService) =>
  provider.redact === undefined ? value : provider.redact(value);

const containsSecret = (value: unknown, provider: AgentProviderService) => {
  const encoded = JSON.stringify(value);
  return encoded !== undefined && redact(encoded, provider) !== encoded;
};

const runAgent = <Success extends Schema.Top, Failure extends Schema.Top>(
  name: string,
  options: AgentRunOptions<Success, Failure>,
) => {
  if (!stableName(name)) return Effect.die("Agent.run requires a non-empty stable name");
  return Effect.gen(function* () {
    const sandbox = yield* CurrentSandbox;
    const provider = yield* AgentProvider;
    const subject = yield* CompositionRuntime.activitySubject(name);
    yield* verifyConfiguration(subject, "Agent", provider.configuration);
    const providerIdentity = safeProviderIdentity(provider.configuration);
    const Outcome = Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("Success"), value: options.success }),
      Schema.Struct({ _tag: Schema.Literal("Failure"), failure: options.failure }),
      Schema.Struct({ _tag: Schema.Literal("ProviderFailure"), failure: AgentProviderFailure }),
    ]);
    const ActivityResult = Schema.Struct({
      artifacts: Schema.Array(
        Schema.Struct({
          byteLength: Schema.Number,
          fingerprint: Schema.String,
          mediaType: Schema.String,
          name: Schema.String,
        }),
      ),
      commits: Schema.Array(Schema.Struct({ sha: Schema.String })),
      outcome: Outcome,
    });
    yield* record({
      details: { provider: providerIdentity },
      idempotencyKey: `agent:${subject}:started`,
      subject,
      type: "Agent.Started",
    });
    const result = yield* Activity.make({
      execute: Effect.tryPromise({
        try: () =>
          sandbox.handle.run({
            agent: provider.agent,
            // Sandcastle otherwise writes an unredacted process log to disk. Its
            // stdout mode is silent when verbose is false; Kojo finalizes only the
            // redacted transcript after the run settles.
            logging: { type: "stdout", verbose: false },
            ...(options.maxIterations === undefined
              ? {}
              : { maxIterations: options.maxIterations }),
            prompt: structuredAgentPrompt(options.prompt),
          }),
        catch: () => ({
          _tag: "Agent.ProviderFailure" as const,
          message: "The Agent Provider could not complete the Agent Step",
        }),
      }).pipe(
        Effect.flatMap((rawResult) =>
          Schema.decodeUnknownEffect(AgentTransportResult)(rawResult).pipe(
            Effect.mapError(() => ({
              _tag: "Agent.ProviderFailure" as const,
              message: "The Agent Provider returned an invalid transport result",
            })),
          ),
        ),
        Effect.flatMap((transport) =>
          Effect.gen(function* () {
            const output =
              transport.output === undefined
                ? yield* outputFromTranscript(transport.stdout)
                : transport.output;
            if (containsSecret(output, provider)) {
              return yield* Effect.die("Agent structured output contains a provider secret");
            }
            const outcome = yield* Schema.decodeUnknownEffect(Outcome)(output).pipe(Effect.orDie);
            const transcript = redact(transport.stdout, provider);
            const artifact = yield* ExecutionArtifactRecorder.pipe(
              Effect.flatMap((recorder) => recorder.finalizeText("transcript", transcript)),
            );
            return { artifacts: [artifact], commits: transport.commits, outcome };
          }),
        ),
        Effect.catchTag("Agent.ProviderFailure", (failure) =>
          Effect.succeed({
            artifacts: [],
            commits: [],
            outcome: { _tag: "ProviderFailure" as const, failure },
          }),
        ),
      ),
      name,
      success: ActivityResult,
    });
    const outcome = result.outcome as
      | { readonly _tag: "Success"; readonly value: Schema.Schema.Type<Success> }
      | { readonly _tag: "Failure"; readonly failure: Schema.Schema.Type<Failure> }
      | { readonly _tag: "ProviderFailure"; readonly failure: AgentProviderFailure };
    if (outcome._tag === "Success") {
      const encodedResult = yield* Schema.encodeUnknownEffect(options.success)(outcome.value).pipe(
        Effect.orDie,
      );
      yield* record({
        details: {
          artifacts: result.artifacts,
          commits: result.commits,
          provider: providerIdentity,
          result: encodedResult,
        },
        idempotencyKey: `agent:${subject}:completed`,
        subject,
        type: "Agent.Completed",
      });
      return outcome.value;
    }
    const failure = outcome.failure;
    const encodedFailure =
      outcome._tag === "Failure"
        ? yield* Schema.encodeUnknownEffect(options.failure)(failure).pipe(Effect.orDie)
        : failure;
    yield* record({
      details: {
        artifacts: result.artifacts,
        failure: encodedFailure,
        provider: providerIdentity,
      },
      idempotencyKey: `agent:${subject}:failed`,
      subject,
      type: "Agent.Failed",
    });
    return yield* Effect.fail(failure);
  });
};

export const Sandbox = Object.freeze({ use: useSandbox });
export const Command = Object.freeze({
  Failure: CommandFailure,
  Result: CommandResult,
  run: runCommand,
});
export const Agent = Object.freeze({ ProviderFailure: AgentProviderFailure, run: runAgent });
