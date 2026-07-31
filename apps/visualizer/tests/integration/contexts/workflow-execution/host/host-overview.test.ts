import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { EMPTY_EXECUTION_TRACE_FILTERS, ProjectIdentity, WorkflowRunId } from "@kojo/control";
import { Effect, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";
import { HostOverviewError } from "../../../../../src/contexts/shared/models/contracts";
import {
  disposeApi,
  handleApiRequest,
  handleArtifactAttachment,
} from "../../../../../src/contexts/shared/server";
import {
  makeVisualizerApiClientLayer,
  VisualizerApiClient,
} from "../../../../../src/contexts/shared/services/client";

afterAll(() => disposeApi());

const sameOriginFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  request.headers.set("origin", new URL(request.url).origin);
  request.headers.set("sec-fetch-site", "same-origin");
  return handleApiRequest(request);
}) as typeof fetch;

const abortingSameOriginFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100);
  const request = new Request(input, { ...init, signal: controller.signal });
  request.headers.set("origin", new URL(request.url).origin);
  request.headers.set("sec-fetch-site", "same-origin");
  return handleApiRequest(request).then((response) => {
    if (response.body === null) clearTimeout(timeout);
    return response;
  });
}) as typeof fetch;

const withHost = <A>(
  use: (
    host: Awaited<ReturnType<typeof startKojoHostProcess>>,
  ) => Effect.Effect<A, unknown, VisualizerApiClient>,
  fetchImplementation: typeof fetch = sameOriginFetch,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const previousSocketPath = process.env.KOJO_HOST_SOCKET;
      const host = await startKojoHostProcess();
      process.env.KOJO_HOST_SOCKET = host.socketPath;
      return { host, previousSocketPath };
    }),
    ({ host }) => use(host),
    ({ host, previousSocketPath }) =>
      Effect.promise(async () => {
        if (previousSocketPath === undefined) delete process.env.KOJO_HOST_SOCKET;
        else process.env.KOJO_HOST_SOCKET = previousSocketPath;
        await host.stop();
      }),
  ).pipe(
    Effect.provide(makeVisualizerApiClientLayer("http://kojo.test/api/rpc")),
    Effect.provideService(FetchHttpClient.Fetch, fetchImplementation),
  );

describe("Host overview", () => {
  it("delivers Artifact bytes only as a nosniff attachment", async () => {
    const request = new Request(
      "http://kojo.test/api/artifacts?project=00000000-0000-7000-8000-000000000001&run=00000000-0000-7000-8000-000000000002&artifact=artifact-1",
    );
    const response = await handleArtifactAttachment(request, async (input) => {
      expect(input).toMatchObject({ artifactId: "artifact-1" });
      return {
        ok: true,
        download: {
          artifact: {
            artifactId: "artifact-1",
            byteSize: 25,
            condition: "available",
            createdAtMs: 1,
            displayName: "untrusted.html",
            mediaType: "text/html",
            sha256: "a".repeat(64),
            unavailableAtMs: null,
            unavailableReasonCode: null,
          },
          contentBase64: Buffer.from("<script>window.pwned = true</script>").toString("base64"),
        },
      };
    });
    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-disposition")).toBe(
      'attachment; filename="artifact-artifact-1.json"',
    );
    expect(response?.headers.get("content-type")).toBe("application/octet-stream");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response?.text()).toBe("<script>window.pwned = true</script>");
  });

  it.effect(
    "proxies a Host-owned Trace query through the real same-origin and Unix-socket boundaries",
    () =>
      withHost(() =>
        Effect.gen(function* () {
          const client = yield* VisualizerApiClient;
          const identity = Schema.decodeUnknownSync(ProjectIdentity)(
            "00000000-0000-7000-8000-000000000001",
          );
          const runId = Schema.decodeUnknownSync(WorkflowRunId)(
            "00000000-0000-7000-8000-000000000002",
          );
          const result = yield* client.ReadExecutionTrace({
            identity,
            runId,
            filters: EMPTY_EXECUTION_TRACE_FILTERS,
            limit: 100,
          });
          expect(result).toMatchObject({ ok: false, error: { code: "project-not-found" } });
        }),
      ),
  );

  it.effect("maps an actual unavailable Host transport to a typed browser error", () => {
    const previousSocketPath = process.env.KOJO_HOST_SOCKET;
    process.env.KOJO_HOST_SOCKET = "/tmp/kojo-missing-visualizer-host.sock";
    return Effect.gen(function* () {
      const client = yield* VisualizerApiClient;
      const error = yield* Effect.flip(client.HostOverview());
      expect(error).toEqual(
        new HostOverviewError({
          code: "host-unavailable",
          message: "Kojo Host is unavailable.",
          next: "Start the Kojo Host and try again.",
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousSocketPath === undefined) delete process.env.KOJO_HOST_SOCKET;
          else process.env.KOJO_HOST_SOCKET = previousSocketPath;
        }),
      ),
      Effect.provide(makeVisualizerApiClientLayer("http://kojo.test/api/rpc")),
      Effect.provideService(FetchHttpClient.Fetch, sameOriginFetch),
    );
  });

  it.effect("is exposed through an explicit same-origin operation", () =>
    withHost(() =>
      Effect.gen(function* () {
        const client = yield* VisualizerApiClient;
        const overview = yield* client.HostOverview();
        expect(overview.host).toMatchObject({
          protocol: { major: 1, minor: 11 },
          capabilities: expect.arrayContaining([
            "traces:read",
            "traces:export",
            "artifacts:read",
            "control:subscribe",
            "control:acknowledge",
          ]),
        });
        expect(overview.projects).toEqual([]);
      }),
    ),
  );

  it.effect("detaches an idle browser subscription from the Host socket on abort", () =>
    withHost(
      (host) =>
        Effect.gen(function* () {
          const client = yield* VisualizerApiClient;
          yield* Stream.runDrain(
            client.SubscribeControl({ projects: [], topics: [], traces: [] }),
          ).pipe(Effect.catchCause(() => Effect.void));
          const diagnostics = yield* Effect.promise(() => readFile(host.diagnosticPath, "utf8"));
          expect(
            diagnostics
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line).operation),
          ).toContain("SubscribeControl");
        }),
      abortingSameOriginFetch,
    ),
  );
});
