import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { HealthHandler } from "../../readiness/server/handlers";
import {
  CompleteWorkflowDeferredHandler,
  DisableWorkflowScheduleHandler,
  EnableWorkflowScheduleHandler,
  HostOverviewHandler,
  ReadExecutionTraceHandler,
  RefreshProjectReadinessHandler,
  RepairProjectReadinessHandler,
  ResumeWorkflowRunHandler,
  StopWorkflowRunHandler,
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
    ? webHandler.handler(request)
    : Promise.resolve(new Response(null, { status: 403 }));

export const disposeApi = webHandler.dispose;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disposeApi();
  });
}
