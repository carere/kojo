import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { RUNNER_PROTOCOL_VERSION } from "@carere/kojo-runner-contracts/contexts/project/contracts/frame";
import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Effect, Layer, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
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

const tracerLayer = Layer.succeed(Tracer, {
  runStarted: () => Effect.void,
  runFinished: () => Effect.void,
  phaseEntered: () => Effect.void,
  phase: () => Effect.void,
  gate: () => Effect.void,
  sandbox: () => Effect.void,
  occurrence: () => Effect.void,
});

/** Execute under the Daemon-assigned Run identity and return committed encoded Phase results. */
export const executeRegisteredRevision = async (
  request: ExecuteRegisteredRequest,
): Promise<ExecuteRegisteredResult> => {
  const { bundle, payload } = await loadRegisteredRevision(request);
  const results = new Map(Object.entries(request.recordedResults));
  const keyOf = (runId: string, revisionId: string, phasePath: string, attempt: number): string =>
    JSON.stringify([runId, revisionId, phasePath, attempt]);
  const repository = Layer.succeed(DaemonExecutionRepository, {
    readResult: (runId, revisionId, phasePath, attempt) =>
      Effect.sync(() => results.get(keyOf(runId, revisionId, phasePath, attempt))),
    commitResult: (runId, revisionId, phasePath, attempt, result) =>
      Effect.sync(() => void results.set(keyOf(runId, revisionId, phasePath, attempt), result)),
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
  return {
    registrationVersion: 1,
    idempotencyKey: bundle.authoredIdempotencyKey(payload),
    enginePayload: bundle.encodeEnginePayload(payload),
    runId: request.runId,
    outcome: outcome._tag === "Success" ? "succeeded" : "failed",
    recordedResults: Object.fromEntries(results),
  };
};

if (import.meta.main) {
  const mode = process.argv[2];
  const request = JSON.parse(await readFile("/dev/stdin", "utf8")) as ExecuteRegisteredRequest;
  const result =
    mode === "inspect"
      ? await inspectRegisteredRevision(request)
      : mode === "execute"
        ? await executeRegisteredRevision(request)
        : await Promise.reject(new Error("the Project Runner needs a private operation mode"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
