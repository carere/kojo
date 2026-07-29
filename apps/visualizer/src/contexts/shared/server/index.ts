import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { HealthHandler } from "../../readiness/server/handlers";
import { HostOverviewHandler } from "../../workflow-execution/host/server/handlers";
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
