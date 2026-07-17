import { Api } from "@kojo/domain/api";
import { Context, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

export class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof Api>>()(
  "visualizer/health/ApiClient",
) {
  static readonly layer = Layer.effect(
    ApiClient,
    HttpApiClient.make(Api, {
      baseUrl: globalThis.location.origin,
    }),
  );
}

export const visualizerRuntime = ManagedRuntime.make(
  ApiClient.layer.pipe(Layer.provideMerge(FetchHttpClient.layer)),
);
