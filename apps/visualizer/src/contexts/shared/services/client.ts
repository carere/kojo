import { Context, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { RpcGroup } from "effect/unstable/rpc";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { VisualizerApi } from "../models/contracts";

export class VisualizerApiClient extends Context.Service<
  VisualizerApiClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof VisualizerApi>, RpcClientError>
>()("kojo/visualizer/ApiClient") {}

export const makeVisualizerApiClientLayer = (url = "/api/rpc") =>
  Layer.effect(VisualizerApiClient)(RpcClient.make(VisualizerApi)).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({ url }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
      ),
    ),
  );

export const visualizerApiRuntime = ManagedRuntime.make(makeVisualizerApiClientLayer());

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void visualizerApiRuntime.dispose();
  });
}
