import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { Workflow as EffectWorkflow, WorkflowEngine } from "effect/unstable/workflow";

interface RuntimeRequest {
  readonly configPath: string;
  readonly input: unknown;
  readonly endpoint?: string;
  readonly leaseGeneration?: number;
  readonly leaseHolder?: string;
  readonly mode: "execute" | "validate";
  readonly runId?: string;
  readonly workflowName: string;
}

const responsePrefix = "KOJO_RUNTIME_RESULT ";

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
    request.endpoint === undefined ||
    request.leaseGeneration === undefined ||
    request.leaseHolder === undefined ||
    request.runId === undefined
  ) {
    throw new Error("Project Runtime execution scope is incomplete");
  }
  const runtimeRunId = request.runId;
  const recordActivity = async (
    name: string,
    attempt: number,
    operation: "Activity.Completed" | "Activity.Started",
    result: unknown,
  ) => {
    const response = await fetch(
      `http://localhost/v1/workflow-runs/${encodeURIComponent(runtimeRunId)}/boundaries`,
      {
        body: JSON.stringify({
          attempt: 1,
          idempotencyKey: `${runtimeRunId}:activity:${name}:${attempt}:${operation}`,
          leaseGeneration: request.leaseGeneration,
          leaseHolder: request.leaseHolder,
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
  };
  const kernel = EffectWorkflow.make(`kojo:${workflow.name}`, {
    error: workflow.failure,
    idempotencyKey: () => request.runId ?? "validation",
    payload: { input: workflow.input },
    success: workflow.success,
  });
  const engineLayer = makeDurableEngineLayer(recordActivity);
  const handlerLayer = kernel
    .toLayer(({ input }) => workflow.run(input) as Effect.Effect<unknown, unknown>)
    .pipe(Layer.provide(engineLayer));
  const program = kernel
    .execute({ input })
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
  return {
    state: "Failed" as const,
    value: { _tag: "Defect", cause: Cause.pretty(exit.cause) },
  };
};

const makeDurableEngineLayer = (
  recordActivity: (
    name: string,
    attempt: number,
    operation: "Activity.Completed" | "Activity.Started",
    result: unknown,
  ) => Promise<void>,
) =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.sync(() => {
      const workflows = new Map<
        string,
        (payload: object, executionId: string) => Effect.Effect<unknown, unknown, unknown>
      >();
      const deferred = new Map<string, Exit.Exit<unknown, unknown>>();
      let engine: WorkflowEngine.WorkflowEngine["Service"];
      engine = WorkflowEngine.makeUnsafe({
        activityExecute: (activity, attempt) =>
          Effect.gen(function* () {
            const parent = yield* WorkflowEngine.WorkflowInstance;
            const activityInstance = WorkflowEngine.WorkflowInstance.initial(
              parent.workflow,
              parent.executionId,
            );
            yield* Effect.promise(() =>
              recordActivity(activity.name, attempt, "Activity.Started", { attempt }),
            );
            const result = yield* activity.executeEncoded.pipe(
              EffectWorkflow.intoResult,
              Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
              Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            );
            yield* Effect.promise(() =>
              recordActivity(activity.name, attempt, "Activity.Completed", result),
            );
            return result;
          }),
        deferredDone: ({ deferredName, executionId, exit }) =>
          Effect.sync(() => {
            deferred.set(`${executionId}:${deferredName}`, exit);
          }),
        deferredResult: (value) =>
          Effect.gen(function* () {
            const instance = yield* WorkflowEngine.WorkflowInstance;
            const stored = deferred.get(`${instance.executionId}:${value.name}`);
            return stored === undefined ? Option.none() : Option.some(stored);
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
        scheduleClock: () => Effect.void,
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
        ? { encodedInput, status: "validated" }
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
