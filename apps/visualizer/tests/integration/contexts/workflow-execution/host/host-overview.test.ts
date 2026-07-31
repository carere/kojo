import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { EMPTY_EXECUTION_TRACE_FILTERS, ProjectIdentity, WorkflowRunId } from "@kojo/control";
import { Effect, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { runKojoCli } from "../../../../../../../tests/support/cli-process";
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

const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);

interface StalledControlServer {
  readonly connected: Promise<void>;
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

const startStalledControlServer = async (): Promise<StalledControlServer> => {
  const directory = await mkdtemp(join(tmpdir(), "kojo-stalled-control-"));
  const socketPath = join(directory, "host.sock");
  const sockets = new Set<Socket>();
  let notifyConnected: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    notifyConnected = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    notifyConnected?.();
    notifyConnected = undefined;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    connected,
    socketPath,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      await rm(directory, { force: true, recursive: true });
    },
  };
};

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

  it.effect("cancels a stalled Artifact Host request when the browser disconnects", () =>
    Effect.acquireUseRelease(
      Effect.promise(startStalledControlServer),
      (server) =>
        Effect.gen(function* () {
          const previousSocketPath = process.env.KOJO_HOST_SOCKET;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previousSocketPath === undefined) delete process.env.KOJO_HOST_SOCKET;
              else process.env.KOJO_HOST_SOCKET = previousSocketPath;
            }),
          );
          process.env.KOJO_HOST_SOCKET = server.socketPath;
          const controller = new AbortController();
          const request = new Request(
            "http://kojo.test/api/artifacts?project=00000000-0000-7000-8000-000000000001&run=00000000-0000-7000-8000-000000000002&artifact=artifact-1",
            { signal: controller.signal },
          );
          request.headers.set("origin", "http://kojo.test");
          request.headers.set("sec-fetch-site", "same-origin");
          const response = handleApiRequest(request);
          yield* Effect.promise(() => server.connected);
          controller.abort();
          const settled = yield* Effect.promise(() =>
            Promise.race([
              response.then((value) => ({ response: value })),
              Bun.sleep(100).then(() => ({ response: undefined })),
            ]),
          );
          expect(settled.response?.status).toBe(503);
        }),
      (server) => Effect.promise(server.stop),
    ),
  );

  it.effect("is exposed through an explicit same-origin operation", () =>
    withHost(() =>
      Effect.gen(function* () {
        const client = yield* VisualizerApiClient;
        const overview = yield* client.HostOverview();
        expect(overview.host).toMatchObject({
          protocol: { major: 1, minor: 12 },
          capabilities: expect.arrayContaining([
            "traces:read",
            "traces:export",
            "artifacts:read",
            "retention:show",
            "retention:set",
            "control:subscribe",
            "control:acknowledge",
          ]),
        });
        expect(overview.projects).toEqual([]);
      }),
    ),
  );

  it.effect("proxies real retention policy, usage, and warnings from the Host adapter", () =>
    withHost((host) =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "kojo-visualizer-retention-")),
        );
        const project = join(directory, "project");
        const git = Bun.spawn(["git", "init", project], { stdout: "ignore", stderr: "ignore" });
        expect(yield* Effect.promise(() => git.exited)).toBe(0);
        yield* Effect.promise(() =>
          mkdir(join(project, "node_modules", "@kojo"), { recursive: true }),
        );
        yield* Effect.promise(() =>
          symlink(workflowPackagePath, join(project, "node_modules", "@kojo", "workflow"), "dir"),
        );
        const initialized = yield* Effect.promise(() =>
          runKojoCli(["init", project], host.socketPath, directory),
        );
        expect(initialized.exitCode, `${initialized.stdout}${initialized.stderr}`).toBe(0);
        const identity = JSON.parse(
          yield* Effect.promise(() => readFile(join(project, ".kojo", "project.json"), "utf8")),
        ).projectIdentity as string;
        const runningRunId = Bun.randomUUIDv7();
        const protectedArtifactId = Bun.randomUUIDv7();
        const missingArtifactId = Bun.randomUUIDv7();
        const database = new Database(join(project, ".kojo", "kojo.sqlite"));
        insertRunningRetentionRun(database, runningRunId, protectedArtifactId);
        insertRunningRetentionRun(database, Bun.randomUUIDv7(), missingArtifactId);
        database.close();
        const protectedPath = join(
          project,
          ".kojo",
          "artifacts",
          runningRunId,
          `${protectedArtifactId}.json`,
        );
        yield* Effect.promise(() =>
          mkdir(join(project, ".kojo", "artifacts", runningRunId), { recursive: true }),
        );
        yield* Effect.promise(() => Bun.write(protectedPath, "12345678"));
        const changed = yield* Effect.promise(() =>
          runKojoCli(
            [
              "retention",
              "set",
              "--project-id",
              identity,
              "--disposable-size",
              "1B",
              "--request-key",
              "visualizer-retention-set",
            ],
            host.socketPath,
            directory,
          ),
        );
        expect(changed.exitCode, `${changed.stdout}${changed.stderr}`).toBe(0);

        const client = yield* VisualizerApiClient;
        const overview = yield* client.HostOverview();
        const retention = overview.retention?.find(
          (snapshot) => snapshot.project.identity === identity,
        );
        expect(retention).toMatchObject({
          policy: { disposableMaxBytes: 1 },
          usage: {
            protectedDisposableBytes: 8,
            missingArtifactCount: 1,
          },
          warnings: expect.arrayContaining([
            expect.objectContaining({ code: "protected-over-limit" }),
            expect.objectContaining({ code: "missing-retained-content" }),
          ]),
        });
        expect(yield* Effect.promise(() => Bun.file(protectedPath).exists())).toBe(true);
        yield* Effect.promise(() => rm(directory, { recursive: true }));
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

const insertRunningRetentionRun = (database: Database, runId: string, artifactId: string) => {
  database
    .query(
      `INSERT INTO kojo_workflow_runs(
         run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision,
         engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind,
         state, last_event_sequence, row_version, accepted_at_ms, updated_at_ms
       ) VALUES (?, ?, zeroblob(32), 'workflow', 'revision', 1, '{}', randomblob(32), 'manual',
         'running', 1, 1, 0, 0)`,
    )
    .run(runId, `start-${runId}`);
  database
    .query(
      `INSERT INTO kojo_execution_artifacts(
         artifact_id, run_id, storage_key, display_name, media_type, byte_size, sha256,
         condition, created_at_ms
       ) VALUES (?, ?, ?, 'retention', 'application/json', 8, zeroblob(32), 'available', 0)`,
    )
    .run(artifactId, runId, `${runId}/${artifactId}.json`);
};
