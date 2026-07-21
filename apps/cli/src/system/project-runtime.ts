import { createHash } from "node:crypto";
import {
  type CreateSandboxOptions,
  createSandbox,
  type Sandbox as SandcastleSandbox,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { Workflow as EffectWorkflow, WorkflowEngine } from "effect/unstable/workflow";

const DurableBoundaryRecorder = Context.Reference<{
  readonly record: (boundary: {
    readonly details?: unknown;
    readonly idempotencyKey: string;
    readonly subject: string;
    readonly type: string;
  }) => Effect.Effect<void>;
}>("@kojo/workflow/DurableBoundaryRecorder", {
  defaultValue: () => ({ record: () => Effect.void }),
});
const DurablePath = Context.Reference<ReadonlyArray<string>>("@kojo/workflow/DurablePath", {
  defaultValue: () => [],
});
const ExecutionAttempt = Context.Reference<number>("@kojo/workflow/ExecutionAttempt", {
  defaultValue: () => 1,
});
const RuntimeConfigurationRecorder = Context.Reference<{
  readonly verify: (subject: string, snapshot: unknown) => Effect.Effect<void>;
}>("@kojo/workflow/RuntimeConfigurationRecorder", {
  defaultValue: () => ({ verify: () => Effect.void }),
});
const SandboxProvider = Context.Service<{
  readonly configuration: {
    readonly adapterVersion: string;
    readonly configurationFingerprint: string;
    readonly name: string;
    readonly publicFields: Readonly<Record<string, string | number | boolean | null>>;
  };
  readonly create: (options: {
    readonly baseBranch?: string;
    readonly branch: string;
  }) => Effect.Effect<
    SandcastleSandbox,
    { readonly _tag: "Sandbox.ProviderFailure"; readonly message: string }
  >;
}>("@kojo/workflow/SandboxProvider");
const ExecutionArtifactRecorder = Context.Reference<{
  readonly finalizeText: (
    name: string,
    content: string,
  ) => Effect.Effect<{
    readonly byteLength: number;
    readonly fingerprint: string;
    readonly mediaType: string;
    readonly name: string;
  }>;
}>("@kojo/workflow/ExecutionArtifactRecorder", {
  defaultValue: () => ({
    finalizeText: (name, content) =>
      Effect.succeed({
        byteLength: Buffer.byteLength(content),
        fingerprint: createHash("sha256").update(content).digest("hex"),
        mediaType: "text/plain; charset=utf-8",
        name,
      }),
  }),
});
const activitySubject = (activityName: string) =>
  DurablePath.pipe(Effect.map((path) => [...path, activityName].join("/")));

const suppressCompensationForLifecycleControl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | WorkflowEngine.WorkflowInstance> =>
  Effect.gen(function* () {
    const instance = yield* WorkflowEngine.WorkflowInstance;
    const exit = yield* Effect.exit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const cause = Cause.pretty(exit.cause);
    if (cause.includes("__KOJO_SUSPENDED__") || cause.includes("__KOJO_DISCARDED__")) {
      yield* Scope.close(instance.scope, Exit.void);
    }
    return yield* Effect.failCause(exit.cause);
  });

interface RuntimeRequest {
  readonly attempt?: number;
  readonly configPath: string;
  readonly input: unknown;
  readonly endpoint?: string;
  readonly leaseGeneration?: number;
  readonly leaseHolder?: string;
  readonly mode: "execute" | "validate";
  readonly projectId?: string;
  readonly projectPath?: string;
  readonly recoveryFailure?: unknown;
  readonly rootRunId?: string;
  readonly runId?: string;
  readonly workflowName: string;
}

const responsePrefix = "KOJO_RUNTIME_RESULT ";

export const localDockerSandboxOptions = (
  projectPath: string,
  imageName: string,
  options: { readonly baseBranch?: string; readonly branch: string },
): CreateSandboxOptions => ({
  ...options,
  cwd: projectPath,
  sandbox: docker({ imageName }),
});

const encodeSchemaValue = async (schema: Schema.Top, value: unknown) =>
  Effect.runPromise(
    Schema.encodeUnknownEffect(schema)(value) as Effect.Effect<unknown, unknown, never>,
  );

const decodeSchemaValue = async (schema: Schema.Top, value: unknown) =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<unknown, unknown, never>,
  );

const loadWorkflow = async (request: RuntimeRequest) => {
  const module = await import(new URL(request.configPath, `file://${process.cwd()}/`).href);
  const config = module.default as {
    readonly workflows?: ReadonlyArray<{
      readonly failure: Schema.Top;
      readonly input: Schema.Top;
      readonly name: string;
      readonly recovery?: Readonly<
        Record<string, (failure: unknown) => Effect.Effect<void, never, unknown>>
      >;
      readonly run: (input: unknown) => Effect.Effect<unknown, unknown, unknown>;
      readonly success: Schema.Top;
    }>;
  };
  if (!Array.isArray(config?.workflows)) {
    throw new Error("kojo.config.ts did not expose a valid Workflow Registry");
  }
  const workflow = config.workflows.find((candidate) => candidate.name === request.workflowName);
  if (workflow === undefined)
    throw new Error(`Developer Workflow '${request.workflowName}' was not found`);
  return workflow;
};

const executeWorkflow = async (
  request: RuntimeRequest,
  workflow: Awaited<ReturnType<typeof loadWorkflow>>,
  input: unknown,
) => {
  if (
    request.attempt === undefined ||
    request.endpoint === undefined ||
    request.leaseGeneration === undefined ||
    request.leaseHolder === undefined ||
    request.projectId === undefined ||
    request.projectPath === undefined ||
    request.rootRunId === undefined ||
    request.runId === undefined
  ) {
    throw new Error("Project Runtime execution scope is incomplete");
  }
  const runtimeRunId = request.runId;
  const runtimeAttempt = request.attempt;
  const runtimeProjectPath = request.projectPath;
  const executionScope = {
    attempt: request.attempt,
    leaseGeneration: request.leaseGeneration,
    leaseHolder: request.leaseHolder,
    projectId: request.projectId,
    rootRunId: request.rootRunId,
  };
  const recordActivity = async (
    executionId: string,
    name: string,
    attempt: number,
    operation: "Activity.Completed" | "Activity.Started",
    result: unknown,
  ) => {
    const activityKey = `${runtimeRunId}:activity:${executionId}:${name}:${attempt}`;
    const response = await fetch(
      `http://localhost/v1/workflow-runs/${encodeURIComponent(runtimeRunId)}/boundaries`,
      {
        body: JSON.stringify({
          ...executionScope,
          ...(operation === "Activity.Started"
            ? { completionIdempotencyKey: `${activityKey}:Activity.Completed` }
            : {}),
          idempotencyKey: `${activityKey}:${operation}`,
          operation,
          payload: result,
          subject: name,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        unix: request.endpoint,
      },
    );
    if (!response.ok) throw new Error(`System Process rejected durable Activity '${name}'`);
    return (await response.json()) as {
      readonly payload?: unknown;
      readonly status:
        | "discard"
        | "discarded"
        | "execute"
        | "recorded"
        | "replay"
        | "suspend"
        | "suspended"
        | "uncertain";
    };
  };
  const readBoundary = async (idempotencyKey: string) => {
    const response = await fetch(
      `http://localhost/v1/workflow-runs/${encodeURIComponent(runtimeRunId)}/journal/read`,
      {
        body: JSON.stringify({ ...executionScope, idempotencyKey }),
        headers: { "content-type": "application/json" },
        method: "POST",
        unix: request.endpoint,
      },
    );
    if (!response.ok) throw new Error("System Process rejected a Workflow Journal read");
    return (await response.json()) as {
      readonly payload?: unknown;
      readonly status: "found" | "missing";
    };
  };
  const recordKernelBoundary = async (
    idempotencyKey: string,
    operation: string,
    payload: unknown,
    subject: string,
  ) => {
    const response = await fetch(
      `http://localhost/v1/workflow-runs/${encodeURIComponent(runtimeRunId)}/boundaries`,
      {
        body: JSON.stringify({
          ...executionScope,
          idempotencyKey,
          operation,
          payload,
          subject,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        unix: request.endpoint,
      },
    );
    if (!response.ok) throw new Error(`System Process rejected durable boundary '${operation}'`);
    const recorded = (await response.json()) as {
      readonly status?: "discard" | "recorded" | "suspend";
    };
    if (recorded.status === "suspend") throw new Error("__KOJO_SUSPENDED__");
    if (recorded.status === "discard") throw new Error("__KOJO_DISCARDED__");
  };
  const verifyRuntimeConfiguration = async (subject: string, snapshot: unknown) => {
    const response = await fetch(
      `http://localhost/v1/workflow-runs/${encodeURIComponent(runtimeRunId)}/runtime-configurations/verify`,
      {
        body: JSON.stringify({ ...executionScope, snapshot, subject }),
        headers: { "content-type": "application/json" },
        method: "POST",
        unix: request.endpoint,
      },
    );
    if (!response.ok) throw new Error("System Process rejected Runtime Configuration");
    const result = (await response.json()) as { readonly status?: string };
    if (result.status === "incompatible") {
      throw new Error(`Runtime Configuration for '${subject}' does not match its durable snapshot`);
    }
  };
  const finalizeTextArtifact = async (name: string, content: string) => {
    const mediaType = "text/plain; charset=utf-8";
    const fingerprint = createHash("sha256").update(content).digest("hex");
    const response = await fetch(
      `http://localhost/v1/workflow-runs/${encodeURIComponent(runtimeRunId)}/artifacts`,
      {
        body: JSON.stringify({
          ...executionScope,
          content: Buffer.from(content).toString("base64"),
          fingerprint,
          mediaType,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        unix: request.endpoint,
      },
    );
    if (!response.ok) throw new Error("System Process rejected an Execution Artifact");
    const artifact = (await response.json()) as {
      readonly byteLength: number;
      readonly fingerprint: string;
      readonly mediaType: string;
    };
    return { ...artifact, name };
  };
  const dockerImage = process.env.KOJO_SANDBOX_IMAGE ?? "sandcastle:kojo";
  const sandboxProviderLayer = Layer.succeed(SandboxProvider, {
    configuration: {
      adapterVersion: "@ai-hero/sandcastle@0.12.0",
      configurationFingerprint: createHash("sha256")
        .update(JSON.stringify({ provider: "docker" }))
        .digest("hex"),
      name: "local-docker",
      publicFields: { image: dockerImage },
    },
    create: (options) =>
      Effect.tryPromise({
        try: () =>
          createSandbox(localDockerSandboxOptions(runtimeProjectPath, dockerImage, options)),
        catch: (error) => ({
          _tag: "Sandbox.ProviderFailure" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      }),
  });
  const kernel = EffectWorkflow.make(`kojo:${workflow.name}`, {
    error: workflow.failure,
    idempotencyKey: () => request.runId ?? "validation",
    payload: { input: workflow.input },
    success: workflow.success,
  });
  const engineLayer = makeDurableEngineLayer({
    readBoundary,
    recordActivity,
    recordKernelBoundary,
  });
  const handlerLayer = kernel
    .toLayer(({ input }) =>
      (workflow.run(input) as Effect.Effect<unknown, unknown>).pipe(
        Effect.provideService(DurableBoundaryRecorder, {
          record: (boundary) =>
            suppressCompensationForLifecycleControl(
              Effect.promise(() =>
                recordKernelBoundary(
                  `${runtimeRunId}:${boundary.idempotencyKey}`,
                  boundary.type,
                  boundary.details ?? {},
                  boundary.subject,
                ),
              ),
            ) as Effect.Effect<void>,
        }),
        Effect.provideService(RuntimeConfigurationRecorder, {
          verify: (subject, snapshot) =>
            suppressCompensationForLifecycleControl(
              Effect.promise(() => verifyRuntimeConfiguration(subject, snapshot)),
            ) as Effect.Effect<void>,
        }),
        Effect.provideService(ExecutionArtifactRecorder, {
          finalizeText: (name, content) =>
            suppressCompensationForLifecycleControl(
              Effect.promise(() => finalizeTextArtifact(name, content)),
            ),
        }),
        Effect.provideService(ExecutionAttempt, runtimeAttempt),
        Effect.provide(sandboxProviderLayer),
      ),
    )
    .pipe(Layer.provide(engineLayer));
  const recoveryInstance = WorkflowEngine.WorkflowInstance.initial(kernel, runtimeRunId);
  const recovery =
    request.recoveryFailure === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const failure = yield* Effect.promise(() =>
            decodeSchemaValue(workflow.failure, request.recoveryFailure),
          );
          const tag =
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            typeof failure._tag === "string"
              ? failure._tag
              : undefined;
          const handler = tag === undefined ? undefined : workflow.recovery?.[tag];
          if (handler === undefined || tag === undefined) {
            return yield* Effect.die("The Failed Workflow Run has no matching Recovery Handler");
          }
          const recoveryKey = `${runtimeRunId}:recovery:${runtimeAttempt}:${tag}`;
          yield* suppressCompensationForLifecycleControl(
            Effect.promise(() =>
              recordKernelBoundary(
                `${recoveryKey}:Recovery.Started`,
                "Recovery.Started",
                { failure },
                tag,
              ),
            ),
          );
          const recoveryExit = yield* Effect.exit(handler(failure));
          yield* suppressCompensationForLifecycleControl(
            Effect.promise(() =>
              recordKernelBoundary(
                `${recoveryKey}:Recovery.${Exit.isSuccess(recoveryExit) ? "Completed" : "Failed"}`,
                Exit.isSuccess(recoveryExit) ? "Recovery.Completed" : "Recovery.Failed",
                Exit.isSuccess(recoveryExit) ? {} : { cause: Cause.pretty(recoveryExit.cause) },
                tag,
              ),
            ),
          );
          if (Exit.isFailure(recoveryExit)) return yield* Effect.failCause(recoveryExit.cause);
        }).pipe(Effect.provideService(WorkflowEngine.WorkflowInstance, recoveryInstance));
  const program = recovery
    .pipe(Effect.andThen(kernel.execute({ input } as never)))
    .pipe(Effect.provide(Layer.merge(engineLayer, handlerLayer)), Effect.scoped);
  const exit = await Effect.runPromiseExit(program as Effect.Effect<unknown, unknown, never>);
  if (Exit.isSuccess(exit)) {
    return {
      state: "Completed" as const,
      value: await encodeSchemaValue(workflow.success, exit.value),
    };
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    return {
      state: "Failed" as const,
      value: await encodeSchemaValue(workflow.failure, failure.value),
    };
  }
  const renderedCause = Cause.pretty(exit.cause);
  if (renderedCause.includes("__KOJO_SUSPENDED__")) {
    return { state: "Suspended" as const };
  }
  if (renderedCause.includes("__KOJO_DISCARDED__")) {
    return { state: "Discarded" as const };
  }
  return {
    state: "Failed" as const,
    value: { _tag: "Defect", cause: renderedCause },
  };
};

const makeDurableEngineLayer = (journal: {
  readonly readBoundary: (
    idempotencyKey: string,
  ) => Promise<{ readonly payload?: unknown; readonly status: "found" | "missing" }>;
  readonly recordActivity: (
    executionId: string,
    name: string,
    attempt: number,
    operation: "Activity.Completed" | "Activity.Started",
    result: unknown,
  ) => Promise<{
    readonly payload?: unknown;
    readonly status:
      | "discard"
      | "discarded"
      | "execute"
      | "recorded"
      | "replay"
      | "suspend"
      | "suspended"
      | "uncertain";
  }>;
  readonly recordKernelBoundary: (
    idempotencyKey: string,
    operation: string,
    payload: unknown,
    subject: string,
  ) => Promise<void>;
}) =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.sync(() => {
      const workflows = new Map<
        string,
        (payload: object, executionId: string) => Effect.Effect<unknown, unknown, unknown>
      >();
      const scheduledClocks = new Set<string>();
      let engine: WorkflowEngine.WorkflowEngine["Service"];
      engine = WorkflowEngine.makeUnsafe({
        activityExecute: (activity, attempt) =>
          Effect.gen(function* () {
            const parent = yield* WorkflowEngine.WorkflowInstance;
            const subject = yield* activitySubject(activity.name);
            const activityInstance = WorkflowEngine.WorkflowInstance.initial(
              parent.workflow,
              parent.executionId,
            );
            const claimed = yield* Effect.promise(() =>
              journal.recordActivity(parent.executionId, subject, attempt, "Activity.Started", {
                attempt,
                idempotencyKey: `${parent.executionId}:${subject}`,
                logicalIdentity: subject,
                ordinal: attempt,
              }),
            );
            if (claimed.status === "replay") {
              return claimed.payload as EffectWorkflow.Result<unknown, unknown>;
            }
            if (claimed.status === "suspend" || claimed.status === "suspended") {
              yield* Scope.close(parent.scope, Exit.void);
              return yield* Effect.die("__KOJO_SUSPENDED__");
            }
            if (claimed.status === "discard" || claimed.status === "discarded") {
              yield* Scope.close(parent.scope, Exit.void);
              return yield* Effect.die("__KOJO_DISCARDED__");
            }
            if (claimed.status !== "execute") {
              return yield* Effect.die(`Activity '${subject}' has an Uncertain Activity Outcome`);
            }
            const result = yield* activity.executeEncoded.pipe(
              EffectWorkflow.intoResult,
              Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
              Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            );
            const completion = yield* Effect.promise(() =>
              journal.recordActivity(
                parent.executionId,
                subject,
                attempt,
                "Activity.Completed",
                result,
              ),
            );
            if (completion.status === "suspend" || completion.status === "suspended") {
              yield* Scope.close(parent.scope, Exit.void);
              return yield* Effect.die("__KOJO_SUSPENDED__");
            }
            if (completion.status === "discard" || completion.status === "discarded") {
              yield* Scope.close(parent.scope, Exit.void);
              return yield* Effect.die("__KOJO_DISCARDED__");
            }
            return result;
          }),
        deferredDone: ({ deferredName, executionId, exit }) =>
          Effect.promise(() =>
            journal.recordKernelBoundary(
              `${executionId}:deferred:${deferredName}`,
              "Deferred.Completed",
              exit,
              deferredName,
            ),
          ),
        deferredResult: (value) =>
          Effect.gen(function* () {
            const instance = yield* WorkflowEngine.WorkflowInstance;
            const stored = yield* Effect.promise(() =>
              journal.readBoundary(`${instance.executionId}:deferred:${value.name}`),
            );
            return stored.status === "missing"
              ? Option.none()
              : Option.some(stored.payload as Exit.Exit<unknown, unknown>);
          }),
        execute: ((definition, options) => {
          const handler = workflows.get(definition._tag);
          if (handler === undefined)
            return Effect.die(`Workflow ${definition._tag} is not registered`);
          if (options.discard) return Effect.void;
          const instance = WorkflowEngine.WorkflowInstance.initial(definition, options.executionId);
          return handler(options.payload, options.executionId).pipe(
            EffectWorkflow.intoResult,
            Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
          ) as Effect.Effect<EffectWorkflow.Result<unknown, unknown>>;
        }) as WorkflowEngine.Encoded["execute"],
        interrupt: () => Effect.void,
        interruptUnsafe: () => Effect.void,
        poll: () => Effect.succeed(Option.none()),
        register: (definition, execute) =>
          Effect.sync(() => {
            workflows.set(definition._tag, execute as never);
          }),
        resume: () => Effect.void,
        scheduleClock: (_workflow, { clock, executionId }) =>
          Effect.gen(function* () {
            const idempotencyKey = `${executionId}:clock:${clock.name}`;
            const stored = yield* Effect.promise(() => journal.readBoundary(idempotencyKey));
            const deadline =
              stored.status === "found"
                ? (stored.payload as { readonly deadline: number }).deadline
                : Date.now() + Duration.toMillis(clock.duration);
            if (stored.status === "missing") {
              yield* suppressCompensationForLifecycleControl(
                Effect.promise(() =>
                  journal.recordKernelBoundary(
                    idempotencyKey,
                    "DurableClock.Scheduled",
                    { deadline },
                    clock.name,
                  ),
                ),
              );
            }
            if (scheduledClocks.has(idempotencyKey)) return;
            scheduledClocks.add(idempotencyKey);
            const remaining = Math.max(0, deadline - Date.now());
            setTimeout(() => {
              void Effect.runPromise(
                engine.deferredDone(clock.deferred, {
                  deferredName: clock.deferred.name,
                  executionId,
                  exit: Exit.void,
                  workflowName: _workflow._tag,
                }),
              ).catch(() => undefined);
            }, remaining);
          }) as Effect.Effect<void>,
      });
      return engine;
    }),
  );

export const runProjectRuntime = async () => {
  let result: unknown;
  try {
    const encoded = process.env.KOJO_RUNTIME_REQUEST;
    if (encoded === undefined) throw new Error("Project Runtime request is missing");
    const request = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as RuntimeRequest;
    const workflow = await loadWorkflow(request);
    const input = await decodeSchemaValue(workflow.input, request.input);
    const encodedInput = await encodeSchemaValue(workflow.input, input);
    result =
      request.mode === "validate"
        ? {
            encodedInput,
            recoveryTags: Object.keys(workflow.recovery ?? {}).sort(),
            status: "validated",
          }
        : await executeWorkflow(request, workflow, input);
  } catch (error) {
    result = {
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
    process.exitCode = 1;
  }
  process.stdout.write(`${responsePrefix}${JSON.stringify(result)}\n`);
};

export const decodeProjectRuntimeResult = (stdout: string): unknown => {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(responsePrefix));
  if (line === undefined) throw new Error("Project Runtime Process returned no result");
  return JSON.parse(line.slice(responsePrefix.length)) as unknown;
};
