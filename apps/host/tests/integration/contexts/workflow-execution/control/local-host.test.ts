import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunSocketServer } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProjectIdentity, RequestKey } from "@kojo/control";
import { connectUnixControlClient, makeLocalClient } from "@kojo/control/local-client";
import { Effect, Exit, Layer, Schema } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { makeFileProjectIndexRepositoryLayer } from "../../../../../src/contexts/workflow-authoring/projects/repositories/file-project-index-repository";
import { GitProjectLayoutLive } from "../../../../../src/contexts/workflow-authoring/projects/services/git-project-layout";
import { SubprocessProjectDefinitionLoaderLive } from "../../../../../src/contexts/workflow-authoring/projects/services/subprocess-project-definition-loader";
import { HostIdentity } from "../../../../../src/contexts/workflow-execution/control/models/host-identity";
import { makeHostDiagnosticLoggerLayer } from "../../../../../src/contexts/workflow-execution/control/services/host-diagnostic-logger";
import {
  type KojoHostServer,
  makeKojoControlServerLayer,
  startKojoHost,
  UnsafeHostStoreError,
} from "../../../../../src/contexts/workflow-execution/control/services/local-host";
import {
  DrizzleProjectRepositoryLive,
  DrizzleWorkflowRunRepositoryLive,
} from "../../../../../src/contexts/workflow-execution/projects/repositories/drizzle-project-repository";
import { makeLocalWorkflowBackendLayer } from "../../../../../src/contexts/workflow-execution/projects/services/local-workflow-backend";
import { ProjectRuntimeLive } from "../../../../../src/contexts/workflow-execution/projects/services/project-runtime";

const cleanups: Array<() => Promise<void>> = [];
const TEST_HOST_IDENTITY = Schema.decodeUnknownSync(HostIdentity)(
  "host:00000000-0000-4000-8000-000000000000",
);
const LegacyHostInformation = Schema.Struct({
  protocol: Schema.Struct({ major: Schema.Number, minor: Schema.Number }),
  hostVersion: Schema.String,
  capabilities: Schema.Array(Schema.Literal("projects:list")),
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("local Kojo Host control", () => {
  it.effect(
    "negotiates and returns the authoritative empty Project list over its Unix socket",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "kojo-host-")));
        const socketPath = join(directory, "host.sock");
        const diagnosticPath = join(directory, "diagnostics.jsonl");
        const server = yield* Effect.promise(() => startTestHost(socketPath, diagnosticPath));
        cleanups.push(() => close(server, directory));

        const legacyHandshake = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connectUnixControlClient(socketPath);
            return yield* client.Negotiate();
          }),
        );
        expect(Schema.decodeUnknownSync(LegacyHostInformation)(legacyHandshake)).toEqual({
          protocol: { major: 1, minor: 3 },
          hostVersion: "0.1.0",
          capabilities: ["projects:list"],
        });

        const overview = yield* makeLocalClient({
          connect: connectUnixControlClient(socketPath),
          maxAttempts: 1,
        }).getHostOverview;

        expect(overview).toEqual({
          host: {
            protocol: { major: 1, minor: 3 },
            hostVersion: "0.1.0",
            capabilities: [
              "projects:list",
              "projects:list-page",
              "projects:show",
              "projects:register",
              "projects:forget",
              "workflows:list",
              "workflows:show",
              "runs:start",
              "runs:list",
              "runs:show",
              "runs:reveal",
            ],
          },
          projects: [],
          projectDefinitions: [],
          workflowRuns: [],
        });
        const directoryMode = yield* Effect.promise(() => stat(directory));
        const diagnosticMode = yield* Effect.promise(() => stat(server.diagnosticPath));
        const lockMode = yield* Effect.promise(() => stat(server.lockPath));
        const socketMode = yield* Effect.promise(() => stat(socketPath));
        expect(directoryMode.mode & 0o777).toBe(0o700);
        expect(diagnosticMode.mode & 0o777).toBe(0o600);
        expect(lockMode.mode & 0o777).toBe(0o600);
        expect(socketMode.mode & 0o777).toBe(0o600);

        const diagnosticContents = yield* Effect.promise(() =>
          readFile(server.diagnosticPath, "utf8"),
        );
        const events = diagnosticContents
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events).toHaveLength(4);
        expect(events.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
          { operation: "Negotiate", outcome: "success" },
          { operation: "Negotiate", outcome: "success" },
          { operation: "NegotiateCapabilities", outcome: "success" },
          { operation: "ListProjects", outcome: "success" },
        ]);
        expect(events[0]).toMatchObject({
          eventVersion: 1,
          eventKind: "host-request.completed",
          hostIdentity: "host:00000000-0000-4000-8000-000000000000",
          hostVersion: "0.1.0",
          protocolMajor: 1,
          protocolMinor: 3,
        });
      }),
  );

  it.effect("refuses a second Host without orphaning the active Host socket", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "kojo-host-owner-")));
      const socketPath = join(directory, "host.sock");
      const first = yield* Effect.promise(() =>
        startTestHost(socketPath, join(directory, "first-diagnostics.jsonl")),
      );
      cleanups.push(() => close(first, directory));

      const secondExit = yield* Effect.exit(
        Effect.promise(() =>
          startTestHost(socketPath, join(directory, "second-diagnostics.jsonl")),
        ),
      );
      if (Exit.isSuccess(secondExit)) cleanups.push(secondExit.value.stop);

      expect(Exit.isFailure(secondExit)).toBe(true);

      const overview = yield* makeLocalClient({
        connect: connectUnixControlClient(socketPath),
        maxAttempts: 1,
      }).getHostOverview;
      expect(overview.host.hostVersion).toBe("0.1.0");
    }),
  );

  it.effect("atomically conflicts concurrent failed forgets that reuse one Request Key", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "kojo-host-forget-")));
      const socketPath = join(directory, "host.sock");
      const server = yield* Effect.promise(() =>
        startTestHost(socketPath, join(directory, "diagnostics.jsonl")),
      );
      cleanups.push(() => close(server, directory));
      const firstIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
        "00000000-0000-7000-8000-000000000001",
      );
      const secondIdentity = Schema.decodeUnknownSync(ProjectIdentity)(
        "00000000-0000-7000-8000-000000000002",
      );
      const requestKey = Schema.decodeUnknownSync(RequestKey)("shared-forget-request");
      const client = makeLocalClient({
        connect: connectUnixControlClient(socketPath),
        maxAttempts: 1,
      });

      const results = yield* Effect.all(
        [
          client.forgetProject(
            firstIdentity,
            { kind: "identity", identity: firstIdentity },
            requestKey,
          ),
          client.forgetProject(
            secondIdentity,
            { kind: "identity", identity: secondIdentity },
            requestKey,
          ),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.map((result) => (result.ok ? "success" : result.error.code)).sort()).toEqual([
        "project-not-found",
        "request-key-conflict",
      ]);
    }),
  );

  it.effect("rejects a Host store that resolves through another user's directory", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "kojo-host-unsafe-store-")),
      );
      cleanups.push(() => rm(directory, { recursive: true }));
      const unsafeDirectory = join(directory, "unsafe");
      yield* Effect.promise(() => symlink(tmpdir(), unsafeDirectory));

      const error = yield* Effect.promise(async () => {
        try {
          await startTestHost(
            join(unsafeDirectory, "host.sock"),
            join(unsafeDirectory, "diagnostics.jsonl"),
          );
          return undefined;
        } catch (cause) {
          return cause;
        }
      });

      expect(error).toBeInstanceOf(UnsafeHostStoreError);
    }),
  );
});

const startTestHost = (socketPath: string, diagnosticPath: string) => {
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide([BunSocketServer.layer({ path: socketPath }), RpcSerialization.layerNdjson]),
  );
  const serverLayer = makeKojoControlServerLayer(
    protocol,
    makeHostDiagnosticLoggerLayer(diagnosticPath),
    TEST_HOST_IDENTITY,
  ).pipe(
    Layer.provide([
      makeFileProjectIndexRepositoryLayer(join(dirname(socketPath), "projects.json")),
      GitProjectLayoutLive.pipe(Layer.provide(SubprocessProjectDefinitionLoaderLive)),
      DrizzleWorkflowRunRepositoryLive,
      ProjectRuntimeLive.pipe(
        Layer.provide([
          DrizzleProjectRepositoryLive,
          makeLocalWorkflowBackendLayer(TEST_HOST_IDENTITY),
        ]),
      ),
    ]),
  ) as Layer.Layer<never, unknown>;
  return startKojoHost({ diagnosticPath, serverLayer, socketPath });
};

const close = async (server: KojoHostServer, directory: string) => {
  await server.stop();
  await rm(directory, { recursive: true });
};
