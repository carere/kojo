import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcTest } from "effect/unstable/rpc";
import { VisualizerApi } from "../../../src/contexts/shared/models/contracts";
import { disposeApi, handleApiRequest } from "../../../src/contexts/shared/server";
import { VisualizerApiHandlers } from "../../../src/contexts/shared/server/handlers";
import {
  makeVisualizerApiClientLayer,
  VisualizerApiClient,
} from "../../../src/contexts/shared/services/client";

const expectedHealth = {
  service: "visualizer",
  status: "ok",
};

afterAll(() => disposeApi());

describe("visualizer health", () => {
  it.effect("is implemented through the RPC contract", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(VisualizerApi);
      const health = yield* client.Health();

      expect(health).toEqual(expectedHealth);
    }).pipe(Effect.provide(VisualizerApiHandlers)),
  );

  it.effect("is available through the Fetch handler", () => {
    const fetchThroughApi = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("origin", new URL(request.url).origin);
      request.headers.set("sec-fetch-site", "same-origin");
      return handleApiRequest(request);
    }) as typeof fetch;

    return Effect.gen(function* () {
      const client = yield* VisualizerApiClient;
      const health = yield* client.Health();

      expect(health).toEqual(expectedHealth);
    }).pipe(
      Effect.provide(makeVisualizerApiClientLayer("http://kojo.test/api/rpc")),
      Effect.provideService(FetchHttpClient.Fetch, fetchThroughApi),
    );
  });

  it.effect("rejects cross-origin browser requests", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        handleApiRequest(
          new Request("http://kojo.test/api/rpc", {
            method: "POST",
            headers: {
              origin: "https://example.com",
            },
          }),
        ),
      );

      expect(response.status).toBe(403);
    }),
  );
});
