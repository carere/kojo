import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { RUNNER_PROTOCOL_VERSION } from "@carere/kojo-runner-contracts/contexts/project/contracts/frame";
import {
  decodeJsonValue,
  type JsonValue,
} from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import type { GateRequest } from "../contexts/gate/models/GateRequest.ts";
import { Gate } from "../contexts/gate/ports/Gate.ts";
import { GateRepository } from "../contexts/gate/ports/GateRepository.ts";
import {
  makeRunnerFrameReader,
  writeRunnerFrame,
} from "../contexts/project/services/runnerChannel.ts";
import { Tracer } from "../contexts/trace/ports/Tracer.ts";
import { Trigger } from "../contexts/trigger/ports/Trigger.ts";
import { layer as daemonEngine } from "../contexts/workflow/adapters/DaemonWorkflowEngine.ts";
import { withRetainedFactoryRoot } from "../contexts/workflow/adapters/RetainedFactoryAssetRepository.ts";
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
  readonly purpose?: "execution" | "trigger";
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
  readonly deferredResults: Readonly<Record<string, JsonValue>>;
  readonly scheduledWakeups: Readonly<Record<string, string>>;
}

export interface ExecuteRegisteredResult extends RegisteredPayload {
  readonly runId: string;
  readonly outcome: "succeeded" | "failed" | "suspended";
  readonly recordedResults: Readonly<Record<string, JsonValue>>;
  readonly phases: ReadonlyArray<RunnerPhaseResult>;
  readonly askings: ReadonlyArray<RunnerAsking>;
  readonly deferredResults: Readonly<Record<string, JsonValue>>;
  readonly scheduledWakeups: Readonly<Record<string, string>>;
}

export interface RunnerAsking {
  readonly runId: string;
  readonly gatePath: string;
  readonly asking: string;
  readonly description: string;
  readonly actor: string;
  readonly choices: ReadonlyArray<string>;
  readonly requestedAt: number;
  readonly deadlineAt: number;
  readonly expiryBranch: "fail" | "reject" | "escalate";
  readonly internalDeferredName: string;
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
  readonly trigger?: Layer.Layer<Trigger, never, unknown>;
}

const hasProperties = (value: unknown): value is Record<string, unknown> =>
  value !== null && (typeof value === "object" || typeof value === "function");

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
};

const loadRegisteredBundle = async (request: BoundRegistrationRequest): Promise<LoadedBundle> => {
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
  return bundle;
};

const loadRegisteredRevision = async (
  request: BoundRegistrationRequest,
): Promise<{ readonly bundle: LoadedBundle; readonly payload: unknown }> => {
  const bundle = await loadRegisteredBundle(request);
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
  const deferredResults = new Map(Object.entries(request.deferredResults));
  const scheduledWakeups = new Map(Object.entries(request.scheduledWakeups));
  const askings = new Map<string, RunnerAsking>();
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
    readDeferred: (runId, deferredName) =>
      Effect.sync(() => deferredResults.get(JSON.stringify([runId, deferredName]))),
    commitDeferred: (runId, deferredName, result) =>
      Effect.sync(() => {
        const key = JSON.stringify([runId, deferredName]);
        if (!deferredResults.has(key)) deferredResults.set(key, result);
      }),
    scheduleWakeup: (runId, deferredName, dueAt) =>
      Effect.sync(() => {
        const key = JSON.stringify([runId, deferredName]);
        if (!scheduledWakeups.has(key)) scheduledWakeups.set(key, new Date(dueAt).toISOString());
      }),
  });
  const gateLayer = Layer.succeed(Gate, {
    request: (asking: GateRequest) =>
      Effect.sync(() => {
        askings.set(asking.asking, {
          runId: asking.runId,
          gatePath: asking.gate,
          asking: asking.asking,
          description: asking.description,
          actor: asking.actor,
          choices: asking.choices,
          requestedAt: asking.requestedAt,
          deadlineAt: asking.deadlineAt,
          expiryBranch: asking.onExpiry,
          internalDeferredName: asking.asking,
        });
      }),
    describe: (asking) => asking.description,
  });
  const gateRepositoryLayer = Layer.succeed(GateRepository, {
    asked: () => Effect.void,
    recorded: () => Effect.succeed(false),
    expired: () => Effect.succeed(false),
    byToken: () => Effect.succeed(Option.none()),
    all: Effect.succeed([]),
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
    Layer.provideMerge(Layer.mergeAll(engineLayer, tracerLayer, gateLayer, gateRepositoryLayer)),
  );
  const execution = Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    yield* engine.execute(bundle.definition as never, {
      executionId: request.runId,
      payload: bundle.encodeEnginePayload(payload),
      discard: true,
    });
    const result = yield* engine.poll(bundle.definition as never, request.runId);
    return Option.getOrThrow(result);
  }).pipe(Effect.provide(registration)) as unknown as Effect.Effect<
    { readonly _tag: "Complete" | "Suspended"; readonly exit?: { readonly _tag?: string } },
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
    outcome:
      outcome._tag === "Suspended"
        ? "suspended"
        : outcome.exit?._tag === "Success"
          ? "succeeded"
          : "failed",
    recordedResults: Object.fromEntries(results),
    phases,
    askings: [...askings.values()],
    deferredResults: Object.fromEntries(deferredResults),
    scheduledWakeups: Object.fromEntries(scheduledWakeups),
  };
};

const triggerRetryDelays = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

class TriggerProcessError extends Data.TaggedError("TriggerProcessError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const triggerProcessError = (cause: unknown): TriggerProcessError =>
  new TriggerProcessError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const runRegisteredTrigger = async (options: {
  readonly registration: BoundRegistrationRequest;
  readonly pollerId: string;
  readonly signal: AbortSignal;
  readonly sendMutation: (
    kind: "AdmitTriggerRequest" | "RecordRejectedTriggerEvent" | "RecordTriggerProgress",
    registration: BoundRegistrationRequest,
    pollerId: string,
    body: JsonValue,
  ) => Promise<Record<string, JsonValue>>;
}): Promise<void> => {
  const bundle = await loadRegisteredBundle(options.registration);
  if (bundle.trigger === undefined)
    throw new Error("the exact Workflow revision does not declare a Trigger");
  const sendMutation = (
    kind: "AdmitTriggerRequest" | "RecordRejectedTriggerEvent" | "RecordTriggerProgress",
    body: JsonValue,
  ): Promise<Record<string, JsonValue>> =>
    options.sendMutation(kind, options.registration, options.pollerId, body);
  const processEvent = async (
    trigger: Trigger["Service"],
    event: Parameters<Trigger["Service"]["ack"]>[0],
  ): Promise<void> => {
    const encodedPayload = decodeJsonValue(event.payload);
    let payload: unknown;
    let rejection: string | undefined;
    if (!encodedPayload.ok) {
      rejection = "the Trigger payload is not a JSON value";
    } else {
      payload = await Effect.runPromise(
        Schema.decodeEffect(bundle.authoredPayloadSchema)(encodedPayload.value) as Effect.Effect<
          unknown,
          Schema.SchemaError,
          never
        >,
      ).catch((cause) => {
        rejection = cause instanceof Error ? cause.message : String(cause);
        return undefined;
      });
      if (rejection === undefined && bundle.authoredIdempotencyKey(payload) !== event.key) {
        rejection = `the Workflow idempotency key does not match Trigger key ${event.key}`;
      }
    }
    const deliveredAt = new Date(event.receivedAt).toISOString();
    if (rejection !== undefined) {
      await sendMutation("RecordRejectedTriggerEvent", {
        projectId: options.registration.projectId,
        workflowName: options.registration.workflowName,
        source: event.source,
        eventId: event.key,
        revisionId: options.registration.revisionId,
        packageGraphId: options.registration.packageGraphId,
        deliveredAt,
        reason: rejection,
      });
      return;
    }
    let admission: Record<string, JsonValue> | undefined;
    for (let attempt = 0; attempt <= triggerRetryDelays.length; attempt += 1) {
      admission = await sendMutation("AdmitTriggerRequest", {
        projectId: options.registration.projectId,
        workflowName: options.registration.workflowName,
        source: event.source,
        eventId: event.key,
        idempotencyKey: event.key,
        payload: encodedPayload.ok ? encodedPayload.value : null,
        revisionId: options.registration.revisionId,
        packageGraphId: options.registration.packageGraphId,
        deliveredAt,
      });
      if (admission.accepted === true) break;
      if (admission.retry !== true || attempt === triggerRetryDelays.length) {
        throw new Error(String(admission.reason ?? "the Trigger event was refused"));
      }
      await Bun.sleep(triggerRetryDelays[attempt] ?? 16_000);
    }
    const runId = admission?.runId;
    if (typeof runId !== "string")
      throw new Error("durable Trigger admission did not return a Run ID");
    let acknowledged = false;
    let acknowledgementCause: unknown;
    for (let attempt = 0; attempt <= triggerRetryDelays.length; attempt += 1) {
      try {
        await Effect.runPromise(trigger.ack(event, { runId: runId as never, outcome: "admitted" }));
        acknowledged = true;
        break;
      } catch (cause) {
        acknowledgementCause = cause;
        if (attempt < triggerRetryDelays.length)
          await Bun.sleep(triggerRetryDelays[attempt] ?? 16_000);
      }
    }
    if (!acknowledged) {
      const reason =
        acknowledgementCause instanceof Error
          ? acknowledgementCause.message
          : String(acknowledgementCause);
      await sendMutation("RecordTriggerProgress", {
        projectId: options.registration.projectId,
        workflowName: options.registration.workflowName,
        state: "failed",
        detail: `Trigger acknowledgement retry cycle was exhausted: ${reason}`,
        observedAt: new Date().toISOString(),
      });
      throw new Error(reason);
    }
    await sendMutation("RecordTriggerProgress", {
      projectId: options.registration.projectId,
      workflowName: options.registration.workflowName,
      state: "polling",
      detail: `event ${event.key} acknowledged after durable admission`,
      observedAt: new Date().toISOString(),
    });
  };
  const program = Effect.gen(function* () {
    const trigger = yield* Trigger;
    yield* trigger.stream.pipe(
      Stream.runForEach((event) =>
        Effect.tryPromise({
          try: () => processEvent(trigger, event),
          catch: triggerProcessError,
        }),
      ),
    );
  }).pipe(Effect.provide(bundle.trigger as Layer.Layer<Trigger, never, never>)) as Effect.Effect<
    void,
    unknown,
    never
  >;
  await Effect.runPromise(program, { signal: options.signal });
  throw new Error("the live Trigger stream ended");
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

    const registrations = new Map<string, BoundRegistrationRequest>();
    const triggers = new Map<
      string,
      { readonly controller: AbortController; readonly running: Promise<void> }
    >();
    const mutationReplies = new Map<
      string,
      {
        readonly resolve: (result: Record<string, JsonValue>) => void;
        readonly reject: (cause: unknown) => void;
      }
    >();
    const registrationKey = (revisionId: string, workflowName: string): string =>
      JSON.stringify([revisionId, workflowName]);
    const reply = (operationRequestId: string, result: JsonValue): Promise<void> =>
      Effect.runPromise(
        writeRunnerFrame(socket, {
          version: 1,
          kind: "Ready",
          requestId: crypto.randomUUID(),
          daemonInstanceId: binding.daemonInstanceId,
          runnerInstanceId: binding.runnerInstanceId,
          body: {
            replyVersion: 1,
            operationRequestId,
            state: "committed",
            result,
          },
        }),
      );
    const stopTrigger = async (key: string): Promise<void> => {
      const active = triggers.get(key);
      if (active === undefined) return;
      active.controller.abort();
      await active.running.catch(() => undefined);
      triggers.delete(key);
    };
    const sendMutation = async (
      kind: "AdmitTriggerRequest" | "RecordRejectedTriggerEvent" | "RecordTriggerProgress",
      registration: BoundRegistrationRequest,
      pollerId: string,
      body: JsonValue,
    ): Promise<Record<string, JsonValue>> => {
      const requestId = crypto.randomUUID();
      const committed = new Promise<Record<string, JsonValue>>((resolve, reject) => {
        mutationReplies.set(requestId, { resolve, reject });
      });
      await Effect.runPromise(
        writeRunnerFrame(socket, {
          version: 1,
          kind,
          requestId,
          daemonInstanceId: binding.daemonInstanceId,
          runnerInstanceId: binding.runnerInstanceId,
          runId: pollerId,
          revisionId: registration.revisionId,
          claimGeneration: 1,
          body,
        }),
      ).catch((cause) => {
        mutationReplies.delete(requestId);
        throw cause;
      });
      return committed;
    };

    let shutdown = false;
    while (!shutdown) {
      const operation = await Effect.runPromise(reader.read);
      assertAddress(operation, binding);
      if (operation.kind === "Ready") {
        const body = operation.body as unknown as {
          readonly operationRequestId?: string;
          readonly state?: string;
          readonly result?: JsonValue;
        };
        const pending =
          typeof body.operationRequestId === "string"
            ? mutationReplies.get(body.operationRequestId)
            : undefined;
        if (
          pending === undefined ||
          body.state !== "committed" ||
          body.result === null ||
          Array.isArray(body.result) ||
          typeof body.result !== "object"
        ) {
          throw new Error("the Daemon did not commit the Trigger operation reply");
        }
        mutationReplies.delete(body.operationRequestId as string);
        pending.resolve(body.result as Record<string, JsonValue>);
        continue;
      }
      if (operation.kind === "RegisterRevision") {
        const body = operation.body as unknown as {
          readonly registrationVersion: 1;
          readonly revisionId: string;
          readonly packageGraphId: string;
          readonly workflowName: string;
          readonly retainedRoot: string;
          readonly entrySource: string;
          readonly payload: JsonValue;
          readonly purpose?: "execution" | "trigger";
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
          ...(body.purpose === undefined ? {} : { purpose: body.purpose }),
          connectionSecret,
        };
        const inspected =
          registration.purpose === "trigger"
            ? {
                registrationVersion: 1 as const,
                triggerDeclared: (await loadRegisteredBundle(registration)).trigger !== undefined,
              }
            : await inspectRegisteredRevision(registration);
        registrations.set(
          registrationKey(registration.revisionId, registration.workflowName),
          registration,
        );
        await reply(operation.requestId, inspected as unknown as JsonValue);
        continue;
      }
      if (operation.kind === "ExecuteRun") {
        const execute = operation.body as unknown as {
          readonly executionVersion: 1;
          readonly workflowName: string;
          readonly payload: JsonValue;
          readonly recordedResults: Readonly<Record<string, JsonValue>>;
          readonly deferredResults: Readonly<Record<string, JsonValue>>;
          readonly scheduledWakeups: Readonly<Record<string, string>>;
        };
        const registration = registrations.get(
          registrationKey(operation.revisionId, execute.workflowName),
        );
        if (registration === undefined || registration.purpose === "trigger") {
          throw new Error("the execution has no exact bound registration");
        }
        const result = await withRetainedFactoryRoot(registration.executionRoot, () =>
          executeRegisteredRevision({
            ...registration,
            runId: operation.runId,
            payload: execute.payload,
            recordedResults: execute.recordedResults,
            deferredResults: execute.deferredResults,
            scheduledWakeups: execute.scheduledWakeups,
          }),
        );
        await reply(operation.requestId, result as unknown as JsonValue);
        continue;
      }
      if (operation.kind === "StartTrigger") {
        const start = operation.body as unknown as {
          readonly pollerId?: string;
          readonly revisionId?: string;
          readonly workflowName?: string;
        };
        if (
          typeof start.pollerId !== "string" ||
          typeof start.revisionId !== "string" ||
          typeof start.workflowName !== "string"
        ) {
          throw new Error("the Trigger start has no exact registration identity");
        }
        const key = registrationKey(start.revisionId, start.workflowName);
        const registration = registrations.get(key);
        if (registration?.purpose !== "trigger") {
          throw new Error("the Trigger start does not match its bound registration");
        }
        if (triggers.has(key)) throw new Error("the Trigger is already polling");
        const controller = new AbortController();
        await reply(operation.requestId, { polling: true });
        const running = Promise.resolve()
          .then(() =>
            withRetainedFactoryRoot(registration.executionRoot, () =>
              runRegisteredTrigger({
                registration,
                pollerId: start.pollerId as string,
                signal: controller.signal,
                sendMutation,
              }),
            ),
          )
          .finally(() => triggers.delete(key));
        triggers.set(key, { controller, running });
        void running.catch(async (cause) => {
          if (controller.signal.aborted) return;
          await Effect.runPromise(
            writeRunnerFrame(socket, {
              version: 1,
              kind: "Fault",
              requestId: crypto.randomUUID(),
              daemonInstanceId: binding.daemonInstanceId,
              runnerInstanceId: binding.runnerInstanceId,
              body: {
                revisionId: registration.revisionId,
                workflowName: registration.workflowName,
                message: cause instanceof Error ? cause.message : String(cause),
              },
            }),
          ).catch(() => undefined);
        });
        continue;
      }
      if (operation.kind === "StopTrigger") {
        const stop = operation.body as unknown as {
          readonly revisionId?: string;
          readonly workflowName?: string;
        };
        if (typeof stop.revisionId !== "string" || typeof stop.workflowName !== "string") {
          throw new Error("the Trigger stop has no exact registration identity");
        }
        await stopTrigger(registrationKey(stop.revisionId, stop.workflowName));
        await reply(operation.requestId, { polling: false });
        continue;
      }
      if (operation.kind === "DisposeRevision") {
        const dispose = operation.body as unknown as {
          readonly revisionId?: string;
          readonly workflowName?: string;
        };
        if (typeof dispose.revisionId !== "string" || typeof dispose.workflowName !== "string") {
          throw new Error("the revision disposal has no exact registration identity");
        }
        const key = registrationKey(dispose.revisionId, dispose.workflowName);
        await stopTrigger(key);
        registrations.delete(key);
        await reply(operation.requestId, { disposed: true });
        continue;
      }
      if (operation.kind === "Shutdown") {
        await Promise.all([...triggers.keys()].map(stopTrigger));
        for (const pending of mutationReplies.values()) {
          pending.reject(new Error("the Project Runner stopped before the mutation reply"));
        }
        mutationReplies.clear();
        await Effect.runPromise(
          writeRunnerFrame(socket, {
            version: 1,
            kind: "Stopped",
            requestId: crypto.randomUUID(),
            daemonInstanceId: binding.daemonInstanceId,
            runnerInstanceId: binding.runnerInstanceId,
            body: { operationRequestId: operation.requestId },
          }),
        );
        shutdown = true;
        continue;
      }
      throw new Error(`the Project Runner received unexpected ${operation.kind}`);
    }
  } finally {
    socket.end();
  }
};

if (import.meta.main) await runPrivateProtocol();
