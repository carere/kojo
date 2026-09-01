import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { RUNNER_PROTOCOL_VERSION } from "@carere/kojo-runner-contracts/contexts/project/contracts/frame";
import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Effect, Layer, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import {
  makeRunnerFrameReader,
  writeRunnerFrame,
} from "../contexts/project/services/runnerChannel.ts";
import { Tracer } from "../contexts/trace/ports/Tracer.ts";
import { layer as daemonEngine } from "../contexts/workflow/adapters/DaemonWorkflowEngine.ts";
import { DaemonExecutionRepository } from "../contexts/workflow/ports/DaemonExecutionRepository.ts";

/** Stable Project Runner composition entry point. Importing it cannot execute a Workflow. */
/** @public */
export const runnerEntryPointVersion = RUNNER_PROTOCOL_VERSION;

export interface BoundRegistrationRequest {
  readonly registrationVersion: 1;
  readonly selectedProtocol: 1;
  readonly daemonInstanceId: string;
  readonly runnerInstanceId: string;
  readonly projectId: string;
  readonly boundProjectId: string;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly boundPackageGraphId: string;
  readonly executionRoot: string;
  readonly workflowName: string;
  readonly entrySource: string;
  readonly payload: unknown;
  readonly connectionSecret: string;
}

export interface RegisteredPayload {
  readonly registrationVersion: 1;
  readonly idempotencyKey: string;
  readonly enginePayload: Record<string, unknown>;
}

export interface ExecuteRegisteredRequest extends BoundRegistrationRequest {
  readonly runId: string;
  readonly recordedResults: Readonly<Record<string, JsonValue>>;
}

export interface ExecuteRegisteredResult extends RegisteredPayload {
  readonly runId: string;
  readonly outcome: "succeeded" | "failed";
  readonly recordedResults: Readonly<Record<string, JsonValue>>;
  readonly phases: ReadonlyArray<RunnerPhaseResult>;
}

export interface RunnerPhaseResult {
  readonly phasePath: string;
  readonly attempt: number;
  readonly kind: "actor" | "code" | "agent";
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly description: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly encodedResult: JsonValue;
}

interface LoadedBundle {
  readonly definition: {
    readonly _tag: string;
    readonly payloadSchema: Schema.Top & { readonly fields: Schema.Struct.Fields };
  };
  readonly layer: Layer.Layer<never, never, unknown>;
  readonly authoredPayloadSchema: Schema.Top;
  readonly authoredIdempotencyKey: (payload: unknown) => string;
  readonly encodeEnginePayload: (payload: unknown) => Record<string, unknown>;
}

const hasProperties = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
};

const loadRegisteredRevision = async (
  request: BoundRegistrationRequest,
): Promise<{ readonly bundle: LoadedBundle; readonly payload: unknown }> => {
  if (
    request.registrationVersion !== 1 ||
    request.selectedProtocol !== 1 ||
    request.daemonInstanceId.length === 0 ||
    request.runnerInstanceId.length === 0 ||
    request.connectionSecret.length < 32 ||
    request.projectId !== request.boundProjectId ||
    request.packageGraphId !== request.boundPackageGraphId
  ) {
    throw new Error("the private Runner binding does not match this registration");
  }
  if (isAbsolute(request.entrySource))
    throw new Error("the Workflow entry must be retained-relative");
  const factory = join(request.executionRoot, ".kojo");
  const source = join(factory, request.entrySource);
  if (!inside(factory, source))
    throw new Error("the Workflow entry escaped retained Factory source");

  // This is the first Factory import. Every scope and compatibility check above has completed.
  const module = (await import(
    `${pathToFileURL(source).href}?revision=${request.revisionId}`
  )) as Record<string, unknown>;
  const bundles = Object.values(module).filter(
    (value): value is LoadedBundle =>
      hasProperties(value) &&
      hasProperties(value.definition) &&
      value.definition._tag === request.workflowName &&
      Layer.isLayer(value.layer) &&
      hasProperties(value.authoredPayloadSchema) &&
      typeof value.authoredIdempotencyKey === "function" &&
      typeof value.encodeEnginePayload === "function",
  );
  if (bundles.length !== 1)
    throw new Error("the exact revision did not register one named Workflow");
  const bundle = bundles[0];
  if (bundle === undefined) throw new Error("the exact revision has no Workflow");
  const payload = await Effect.runPromise(
    Schema.decodeUnknownEffect(bundle.authoredPayloadSchema)(request.payload) as Effect.Effect<
      unknown,
      Schema.SchemaError,
      never
    >,
  );
  return { bundle, payload };
};

/** Bind protocol, Project, graph, instance, and secret before this function imports Factory code. */
export const inspectRegisteredRevision = async (
  request: BoundRegistrationRequest,
): Promise<RegisteredPayload> => {
  const { bundle, payload } = await loadRegisteredRevision(request);
  return {
    registrationVersion: 1,
    idempotencyKey: bundle.authoredIdempotencyKey(payload),
    enginePayload: bundle.encodeEnginePayload(payload),
  };
};

/** Execute under the Daemon-assigned Run identity and return committed encoded Phase results. */
export const executeRegisteredRevision = async (
  request: ExecuteRegisteredRequest,
): Promise<ExecuteRegisteredResult> => {
  const { bundle, payload } = await loadRegisteredRevision(request);
  const results = new Map(Object.entries(request.recordedResults));
  const initiallyRecorded = new Set(results.keys());
  const completedPhases = new Map<string, Omit<RunnerPhaseResult, "encodedResult">>();
  const activityTimes = new Map<string, { readonly startedAt: number; readonly endedAt: number }>();
  const keyOf = (runId: string, revisionId: string, phasePath: string, attempt: number): string =>
    JSON.stringify([runId, revisionId, phasePath, attempt]);
  const repository = Layer.succeed(DaemonExecutionRepository, {
    readResult: (runId, revisionId, phasePath, attempt) =>
      Effect.sync(() => results.get(keyOf(runId, revisionId, phasePath, attempt))),
    commitResult: (runId, revisionId, phasePath, attempt, result, timing) =>
      Effect.sync(() => {
        const key = keyOf(runId, revisionId, phasePath, attempt);
        results.set(key, result);
        activityTimes.set(key, timing);
      }),
  });
  const tracerLayer = Layer.succeed(Tracer, {
    runStarted: () => Effect.void,
    runFinished: () => Effect.void,
    phaseEntered: () => Effect.void,
    phase: (phase) =>
      Effect.sync(() => {
        completedPhases.set(keyOf(request.runId, request.revisionId, phase.name, phase.attempt), {
          phasePath: phase.name,
          attempt: phase.attempt,
          kind: phase.kind,
          outcome: phase.outcome,
          description: phase.description,
          startedAt: new Date(phase.startedAt).toISOString(),
          endedAt: new Date(phase.endedAt).toISOString(),
        });
      }),
    gate: () => Effect.void,
    sandbox: () => Effect.void,
    occurrence: () => Effect.void,
  });
  const engineLayer = daemonEngine(request.revisionId).pipe(Layer.provide(repository));
  // Dynamic authored layers have a service type known only in their own Project process.
  const authoredLayer = bundle.layer as unknown as Layer.Layer<
    never,
    never,
    Tracer | WorkflowEngine.WorkflowEngine
  >;
  const registration = authoredLayer.pipe(
    Layer.provideMerge(Layer.merge(engineLayer, tracerLayer)),
  );
  const execution = Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    return yield* Effect.result(
      engine.execute(bundle.definition as never, {
        executionId: request.runId,
        payload: bundle.encodeEnginePayload(payload),
        discard: false,
      }),
    );
  }).pipe(Effect.provide(registration)) as unknown as Effect.Effect<
    { readonly _tag: "Success" | "Failure" },
    never,
    never
  >;
  const outcome = await Effect.runPromise(execution);
  const phases = Array.from(results.entries()).flatMap(([key, encodedResult]) => {
    if (initiallyRecorded.has(key)) return [];
    const tuple = JSON.parse(key) as [string, string, string, number];
    const timing = activityTimes.get(key);
    if (timing === undefined) return [];
    const phase = completedPhases.get(key) ?? {
      phasePath: tuple[2],
      attempt: tuple[3],
      kind: "code" as const,
      outcome: "succeeded" as const,
      description: "__kojo_internal_activity__",
      startedAt: new Date(timing.startedAt).toISOString(),
      endedAt: new Date(timing.endedAt).toISOString(),
    };
    return [{ ...phase, encodedResult }];
  });
  return {
    registrationVersion: 1,
    idempotencyKey: bundle.authoredIdempotencyKey(payload),
    enginePayload: bundle.encodeEnginePayload(payload),
    runId: request.runId,
    outcome: outcome._tag === "Success" ? "succeeded" : "failed",
    recordedResults: Object.fromEntries(results),
    phases,
  };
};

interface RunnerBinding {
  readonly daemonInstanceId: string;
  readonly runnerInstanceId: string;
  readonly projectId: string;
  readonly packageGraphId: string;
}

const openPrivateChannel = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });

const assertAddress = (
  frame: { readonly daemonInstanceId: string; readonly runnerInstanceId: string },
  binding: RunnerBinding,
): void => {
  if (
    frame.daemonInstanceId !== binding.daemonInstanceId ||
    frame.runnerInstanceId !== binding.runnerInstanceId
  ) {
    throw new Error("the private Runner frame has a different instance binding");
  }
};

const runPrivateProtocol = async (): Promise<void> => {
  const channel = process.env.KOJO_RUNNER_CHANNEL;
  const encodedBinding = process.env.KOJO_RUNNER_BINDING;
  if (channel === undefined || encodedBinding === undefined)
    throw new Error("the Project Runner needs a private channel binding");
  const binding = JSON.parse(encodedBinding) as RunnerBinding;
  const connectionSecret = (await readFile("/dev/stdin", "utf8")).trim();
  const socket = await openPrivateChannel(channel);
  const reader = makeRunnerFrameReader(socket);
  try {
    const helloRequestId = crypto.randomUUID();
    await Effect.runPromise(
      writeRunnerFrame(socket, {
        version: 1,
        kind: "Hello",
        requestId: helloRequestId,
        daemonInstanceId: binding.daemonInstanceId,
        runnerInstanceId: binding.runnerInstanceId,
        body: {
          helloVersion: 1,
          connectionSecret,
          packageGraphId: binding.packageGraphId,
          projectId: binding.projectId,
          supportedProtocols: [1],
          requiredFeatures: [],
        },
      }),
    );
    const welcome = await Effect.runPromise(reader.read);
    assertAddress(welcome, binding);
    if (
      welcome.kind !== "Welcome" ||
      welcome.body.packageGraphId !== binding.packageGraphId ||
      welcome.body.projectId !== binding.projectId ||
      welcome.body.selectedProtocol !== 1
    ) {
      throw new Error("the Daemon Welcome does not match the Runner binding");
    }

    const register = await Effect.runPromise(reader.read);
    assertAddress(register, binding);
    if (register.kind !== "RegisterRevision")
      throw new Error("the first bound Runner operation must register a revision");
    const body = register.body as unknown as {
      readonly registrationVersion: 1;
      readonly revisionId: string;
      readonly packageGraphId: string;
      readonly workflowName: string;
      readonly retainedRoot: string;
      readonly entrySource: string;
      readonly payload: JsonValue;
    };
    const registration: BoundRegistrationRequest = {
      registrationVersion: body.registrationVersion,
      selectedProtocol: 1,
      daemonInstanceId: binding.daemonInstanceId,
      runnerInstanceId: binding.runnerInstanceId,
      projectId: binding.projectId,
      boundProjectId: binding.projectId,
      revisionId: body.revisionId,
      packageGraphId: body.packageGraphId,
      boundPackageGraphId: binding.packageGraphId,
      executionRoot: body.retainedRoot,
      workflowName: body.workflowName,
      entrySource: body.entrySource,
      payload: body.payload,
      connectionSecret,
    };
    const inspected = await inspectRegisteredRevision(registration);
    await Effect.runPromise(
      writeRunnerFrame(socket, {
        version: 1,
        kind: "Ready",
        requestId: crypto.randomUUID(),
        daemonInstanceId: binding.daemonInstanceId,
        runnerInstanceId: binding.runnerInstanceId,
        body: {
          replyVersion: 1,
          operationRequestId: register.requestId,
          state: "committed",
          result: inspected as unknown as JsonValue,
        },
      }),
    );

    const operation = await Effect.runPromise(reader.read);
    assertAddress(operation, binding);
    if (operation.kind === "ExecuteRun") {
      if (operation.revisionId !== registration.revisionId) {
        throw new Error("the execution revision does not match the bound registration");
      }
      const execute = operation.body as unknown as {
        readonly executionVersion: 1;
        readonly workflowName: string;
        readonly payload: JsonValue;
        readonly recordedResults: Readonly<Record<string, JsonValue>>;
      };
      const result = await executeRegisteredRevision({
        ...registration,
        runId: operation.runId,
        workflowName: execute.workflowName,
        payload: execute.payload,
        recordedResults: execute.recordedResults,
      });
      await Effect.runPromise(
        writeRunnerFrame(socket, {
          version: 1,
          kind: "Ready",
          requestId: crypto.randomUUID(),
          daemonInstanceId: binding.daemonInstanceId,
          runnerInstanceId: binding.runnerInstanceId,
          body: {
            replyVersion: 1,
            operationRequestId: operation.requestId,
            state: "committed",
            result: result as unknown as JsonValue,
          },
        }),
      );
    } else if (operation.kind !== "Shutdown") {
      throw new Error("the Project Runner received an unexpected bound operation");
    }

    const shutdown =
      operation.kind === "Shutdown" ? operation : await Effect.runPromise(reader.read);
    assertAddress(shutdown, binding);
    if (shutdown.kind !== "Shutdown") throw new Error("the Project Runner needs Shutdown");
    await Effect.runPromise(
      writeRunnerFrame(socket, {
        version: 1,
        kind: "Stopped",
        requestId: crypto.randomUUID(),
        daemonInstanceId: binding.daemonInstanceId,
        runnerInstanceId: binding.runnerInstanceId,
        body: null,
      }),
    );
  } finally {
    socket.end();
  }
};

if (import.meta.main) await runPrivateProtocol();
