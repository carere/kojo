import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { HostControlClient } from "../../../src/contexts/workflow-execution/host/services/host-control-client";

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
    }).pipe(
      Effect.provide(VisualizerApiHandlers),
      Effect.provideService(HostControlClient, {
        getHostOverview: Effect.succeed({
          host: {
            protocol: { major: 1, minor: 0 },
            hostVersion: "0.1.0",
            capabilities: ["projects:list"],
          },
          projects: [],
        }),
      }),
    ),
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

  it.effect("exposes the Host overview through an explicit same-origin operation", () => {
    const fetchThroughApi = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("origin", new URL(request.url).origin);
      request.headers.set("sec-fetch-site", "same-origin");
      return handleApiRequest(request);
    }) as typeof fetch;

    return Effect.acquireUseRelease(
      Effect.promise(startTemporaryHost),
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
      ({ directory, previousSocketPath, server }) =>
        Effect.promise(async () => {
          if (previousSocketPath === undefined) delete process.env.KOJO_HOST_SOCKET;
          else process.env.KOJO_HOST_SOCKET = previousSocketPath;
          server.kill("SIGTERM");
          await server.exited;
          await rm(directory, { recursive: true });
        }),
    ).pipe(
      Effect.provide(makeVisualizerApiClientLayer("http://kojo.test/api/rpc")),
      Effect.provideService(FetchHttpClient.Fetch, fetchThroughApi),
    );
  });
});

const startTemporaryHost = async () => {
  const directory = await mkdtemp(join(tmpdir(), "kojo-visualizer-host-"));
  const socketPath = join(directory, "host.sock");
  const previousSocketPath = process.env.KOJO_HOST_SOCKET;
  process.env.KOJO_HOST_SOCKET = socketPath;
  const server = Bun.spawn(["bun", "run", "../host/main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, KOJO_HOST_SOCKET: socketPath },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 50 && !(await Bun.file(socketPath).exists()); attempt += 1) {
    await Bun.sleep(10);
  }
  return { directory, previousSocketPath, server };
};
