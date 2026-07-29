import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { connectUnixTransport, makeLocalClient } from "@kojo/control/local-client";
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
          connect: connectUnixTransport(socketPath),
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
      }),
  );
});

const close = async (server: KojoHostServer, directory: string) => {
  await server.stop();
  await rm(directory, { recursive: true });
};
