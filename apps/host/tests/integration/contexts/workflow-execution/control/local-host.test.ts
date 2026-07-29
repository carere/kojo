import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { connectUnixControlClient, makeLocalClient } from "@kojo/control/local-client";
import { Effect } from "effect";
import {
  type KojoHostServer,
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
        const server = yield* Effect.promise(() => startKojoHost({ socketPath }));
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
        const socketMode = yield* Effect.promise(() => stat(socketPath));
        expect(directoryMode.mode & 0o777).toBe(0o700);
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
          hostVersion: "0.1.0",
          protocolMajor: 1,
          protocolMinor: 0,
        });
      }),
  );
});

const close = async (server: KojoHostServer, directory: string) => {
  await server.stop();
  await rm(directory, { recursive: true });
};
