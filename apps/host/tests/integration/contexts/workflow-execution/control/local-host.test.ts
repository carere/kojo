import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSocketServer } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { connectUnixControlClient, makeLocalClient } from "@kojo/control/local-client";
import { Effect, Exit, Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { makeHostDiagnosticLoggerLayer } from "../../../../../src/contexts/shared/services/host-diagnostic-logger";
import {
  type KojoHostServer,
  makeKojoControlServerLayer,
  startKojoHost,
} from "../../../../../src/contexts/workflow-execution/control/services/local-host";

const cleanups: Array<() => Promise<void>> = [];

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
            capabilities: ["projects:list"],
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
          hostIdentity: "host:test",
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
});

const startTestHost = (socketPath: string, diagnosticPath: string) => {
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide([BunSocketServer.layer({ path: socketPath }), RpcSerialization.layerNdjson]),
  );
  const serverLayer = makeKojoControlServerLayer(
    protocol,
    makeHostDiagnosticLoggerLayer(diagnosticPath),
    "host:test",
  );
  return startKojoHost({ diagnosticPath, serverLayer, socketPath });
};

const close = async (server: KojoHostServer, directory: string) => {
  await server.stop();
  await rm(directory, { recursive: true });
};
