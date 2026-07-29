import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunSocketServer } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { connectUnixControlClient, makeLocalClient } from "@kojo/control/local-client";
import { Effect, Exit, Layer, Schema } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { makeFileProjectIndexStoreLayer } from "../../../../../src/contexts/workflow-authoring/projects/adapters/file-project-index-store";
import { GitProjectLayoutLive } from "../../../../../src/contexts/workflow-authoring/projects/adapters/git-project-layout";
import { HostIdentity } from "../../../../../src/contexts/workflow-execution/control/models/host-identity";
import { makeHostDiagnosticLoggerLayer } from "../../../../../src/contexts/workflow-execution/control/services/host-diagnostic-logger";
import {
  type KojoHostServer,
  makeKojoControlServerLayer,
  startKojoHost,
  UnsafeHostStoreError,
} from "../../../../../src/contexts/workflow-execution/control/services/local-host";

const cleanups: Array<() => Promise<void>> = [];
const TEST_HOST_IDENTITY = Schema.decodeUnknownSync(HostIdentity)(
  "host:00000000-0000-4000-8000-000000000000",
);

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

        const overview = yield* makeLocalClient({
          connect: connectUnixControlClient(socketPath),
          maxAttempts: 1,
        }).getHostOverview;

        expect(overview).toEqual({
          host: {
            protocol: { major: 1, minor: 0 },
            hostVersion: "0.1.0",
            capabilities: [
              "projects:list",
              "projects:show",
              "projects:register",
              "projects:forget",
            ],
          },
          projects: [],
        });
        const directoryMode = yield* Effect.promise(() => stat(directory));
        const lockMode = yield* Effect.promise(() => stat(server.lockPath));
        const socketMode = yield* Effect.promise(() => stat(socketPath));
        expect(directoryMode.mode & 0o777).toBe(0o700);
        expect(lockMode.mode & 0o777).toBe(0o600);
        expect(socketMode.mode & 0o777).toBe(0o600);

        const diagnosticContents = yield* Effect.promise(() =>
          readFile(server.diagnosticPath, "utf8"),
        );
        const events = diagnosticContents
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events).toHaveLength(2);
        expect(events.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
          { operation: "Negotiate", outcome: "success" },
          { operation: "ListProjects", outcome: "success" },
        ]);
        expect(events[0]).toMatchObject({
          eventVersion: 1,
          eventKind: "host-request.completed",
          hostIdentity: "host:00000000-0000-4000-8000-000000000000",
          hostVersion: "0.1.0",
          protocolMajor: 1,
          protocolMinor: 0,
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
      makeFileProjectIndexStoreLayer(join(dirname(socketPath), "projects.json")),
      GitProjectLayoutLive,
    ]),
  );
  return startKojoHost({ diagnosticPath, serverLayer, socketPath });
};

const close = async (server: KojoHostServer, directory: string) => {
  await server.stop();
  await rm(directory, { recursive: true });
};
