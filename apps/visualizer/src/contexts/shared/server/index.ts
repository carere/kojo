import { Layer } from "effect";
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
  StopWorkflowRunHandler,
  SubscribeControlHandler,
} from "../../workflow-execution/host/server/handlers";
import { HostControlClientLive } from "../../workflow-execution/host/services/host-control-client";
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
    ? webHandler
        .handler(request)
        .then((response) => detachResponseOnAbort(response, request.signal))
    : Promise.resolve(new Response(null, { status: 403 }));

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
