import {
  type ExecutionArtifactDownloadInput,
  type ExecutionArtifactDownloadResult,
  ProjectIdentity,
  WorkflowRunId,
} from "@kojo/control";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { HealthHandler } from "../../readiness/server/handlers";
import {
  AcknowledgeControlSubscriptionHandler,
  CompleteWorkflowDeferredHandler,
  DisableWorkflowScheduleHandler,
  EnableWorkflowScheduleHandler,
  HostOverviewHandler,
  ReadExecutionTraceHandler,
  RefreshProjectReadinessHandler,
  RepairProjectReadinessHandler,
  ResumeWorkflowRunHandler,
  RevealWorkflowRunHandler,
  StartWorkflowRunHandler,
  StopWorkflowRunHandler,
  SubscribeControlHandler,
} from "../../workflow-execution/host/server/handlers";
import { HostControlClientLive } from "../../workflow-execution/host/services/host-control-client";
import { downloadExecutionArtifact } from "../../workflow-execution/host/use-cases/get-host-overview";
import { VisualizerApi } from "../models/contracts";

const VisualizerApiLive = RpcServer.layerHttp({
  group: VisualizerApi,
  path: "/api/rpc",
  protocol: "http",
}).pipe(
  Layer.provide([
    HealthHandler,
    HostOverviewHandler.pipe(Layer.provide(HostControlClientLive)),
    RefreshProjectReadinessHandler.pipe(Layer.provide(HostControlClientLive)),
    RepairProjectReadinessHandler.pipe(Layer.provide(HostControlClientLive)),
    EnableWorkflowScheduleHandler.pipe(Layer.provide(HostControlClientLive)),
    DisableWorkflowScheduleHandler.pipe(Layer.provide(HostControlClientLive)),
    ResumeWorkflowRunHandler.pipe(Layer.provide(HostControlClientLive)),
    CompleteWorkflowDeferredHandler.pipe(Layer.provide(HostControlClientLive)),
    StopWorkflowRunHandler.pipe(Layer.provide(HostControlClientLive)),
    StartWorkflowRunHandler.pipe(Layer.provide(HostControlClientLive)),
    RevealWorkflowRunHandler.pipe(Layer.provide(HostControlClientLive)),
    ReadExecutionTraceHandler.pipe(Layer.provide(HostControlClientLive)),
    SubscribeControlHandler.pipe(Layer.provide(HostControlClientLive)),
    AcknowledgeControlSubscriptionHandler.pipe(Layer.provide(HostControlClientLive)),
    RpcSerialization.layerNdjson,
  ]),
);

const webHandler = HttpRouter.toWebHandler(VisualizerApiLive);

const isSameOrigin = (request: Request) => {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }

  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
};

export const handleApiRequest = (request: Request) =>
  isSameOrigin(request)
    ? handleArtifactAttachment(request).then((attachment) =>
        attachment === undefined
          ? webHandler
              .handler(request)
              .then((response) => detachResponseOnAbort(response, request.signal))
          : attachment,
      )
    : Promise.resolve(new Response(null, { status: 403 }));

/**
 * This is intentionally a plain attachment endpoint instead of an RPC method:
 * Artifact bytes never enter browser-rendered JSON or inherit their media type.
 */
type ArtifactDownloader = (
  input: ExecutionArtifactDownloadInput,
  signal: AbortSignal,
) => Promise<ExecutionArtifactDownloadResult>;

/** Interrupts the scoped Host request as soon as the browser disconnects. */
const interruptWhenAborted = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const onAbort = () => resume(Effect.interrupt);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const downloadArtifactForRequest = (input: ExecutionArtifactDownloadInput, signal: AbortSignal) =>
  Effect.runPromise(
    Effect.raceFirst(
      downloadExecutionArtifact(input).pipe(Effect.provide(HostControlClientLive)),
      interruptWhenAborted(signal),
    ),
  );

/**
 * Builds an intentionally inert Artifact attachment response. Keeping the
 * downloader injectable lets the HTTP safety contract be verified without a
 * browser ever rendering the Artifact's content.
 */
export const handleArtifactAttachment = async (
  request: Request,
  download: ArtifactDownloader = downloadArtifactForRequest,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/artifacts") return undefined;
  let identity: string;
  let runId: string;
  const artifactId = url.searchParams.get("artifact");
  try {
    identity = Schema.decodeUnknownSync(ProjectIdentity)(url.searchParams.get("project"));
    runId = Schema.decodeUnknownSync(WorkflowRunId)(url.searchParams.get("run"));
  } catch {
    return new Response("Invalid Artifact request.", { status: 400 });
  }
  if (artifactId === null || artifactId.length === 0 || artifactId.length > 128) {
    return new Response("Invalid Artifact request.", { status: 400 });
  }
  try {
    const result = await download(
      {
        artifactId,
        identity: identity as never,
        runId: runId as never,
      },
      request.signal,
    );
    if (!result.ok) {
      return new Response("Execution Artifact is unavailable.", {
        status: result.error.code === "execution-artifact-not-found" ? 404 : 410,
      });
    }
    const bytes = Buffer.from(result.download.contentBase64, "base64");
    return new Response(bytes, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="artifact-${result.download.artifact.artifactId}.json"`,
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
      status: 200,
    });
  } catch {
    return new Response("Kojo Host is unavailable.", { status: 503 });
  }
};

export const disposeApi = webHandler.dispose;

/**
 * The framework adapter gives us a Fetch Response after its RPC handler has
 * started. Propagate an aborted browser request to that response body so an
 * idle streaming subscription releases its Host socket promptly.
 */
/** @internal Ensures an aborted browser body waits for its server scope to detach. */
export const detachResponseOnAbort = (response: Response, signal: AbortSignal) => {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  const cancel = (reason: unknown) => {
    if (cancellation !== undefined) return cancellation;
    cancellation = reader.cancel(reason).finally(removeAbortListener);
    return cancellation;
  };
  const onAbort = () => void cancel(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) void cancel(signal.reason);
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            if (cancellation !== undefined) {
              await cancellation;
            }
            removeAbortListener();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          removeAbortListener();
          controller.error(error);
        }
      },
      cancel,
    }),
    { headers: response.headers, status: response.status, statusText: response.statusText },
  );
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disposeApi();
  });
}
