import { afterAll, describe, expect, it } from "@effect/vitest";
import { LocalTransportError } from "@kojo/control/local-client";
import { startKojoHostProcess } from "@kojo/test-support";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcTest } from "effect/unstable/rpc";
import {
  HostOverviewError,
  VisualizerApi,
} from "../../../../../src/contexts/shared/models/contracts";
import { disposeApi, handleApiRequest } from "../../../../../src/contexts/shared/server";
import { VisualizerApiHandlers } from "../../../../../src/contexts/shared/server/handlers";
import {
  makeVisualizerApiClientLayer,
  VisualizerApiClient,
} from "../../../../../src/contexts/shared/services/client";
import { HostControlClient } from "../../../../../src/contexts/workflow-execution/host/services/host-control-client";

afterAll(() => disposeApi());

describe("Host overview", () => {
  it.effect("preserves safe transport failures as typed browser-operation errors", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(VisualizerApi);
      const error = yield* Effect.flip(client.HostOverview());

      expect(error).toEqual(
        new HostOverviewError({
          code: "host-unavailable",
          message: "Kojo Host is unavailable.",
          next: "Start the Kojo Host and try again.",
        }),
      );
    }).pipe(
      Effect.provide(VisualizerApiHandlers),
      Effect.provideService(HostControlClient, {
        getHostOverview: Effect.fail(
          new LocalTransportError({ message: "Kojo Host is unavailable." }),
        ),
      }),
    ),
  );

  it.effect("is exposed through an explicit same-origin operation", () => {
    const fetchThroughApi = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("origin", new URL(request.url).origin);
      request.headers.set("sec-fetch-site", "same-origin");
      return handleApiRequest(request);
    }) as typeof fetch;

    return Effect.acquireUseRelease(
      Effect.promise(async () => {
        const previousSocketPath = process.env.KOJO_HOST_SOCKET;
        const host = await startKojoHostProcess();
        process.env.KOJO_HOST_SOCKET = host.socketPath;
        return { host, previousSocketPath };
      }),
      () =>
        Effect.gen(function* () {
          const client = yield* VisualizerApiClient;
          const overview = yield* client.HostOverview();

          expect(overview).toEqual({
            host: {
              protocol: { major: 1, minor: 0 },
              hostVersion: "0.1.0",
              capabilities: ["projects:list"],
            },
            projects: [],
          });
        }),
      ({ host, previousSocketPath }) =>
        Effect.promise(async () => {
          if (previousSocketPath === undefined) delete process.env.KOJO_HOST_SOCKET;
          else process.env.KOJO_HOST_SOCKET = previousSocketPath;
          await host.stop();
        }),
    ).pipe(
      Effect.provide(makeVisualizerApiClientLayer("http://kojo.test/api/rpc")),
      Effect.provideService(FetchHttpClient.Fetch, fetchThroughApi),
    );
  });
});
