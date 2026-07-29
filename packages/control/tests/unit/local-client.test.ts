import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  IncompatibleProtocolError,
  type LocalTransport,
  LocalTransportError,
  makeLocalClient,
} from "../../src/local-client";

const handshake = {
  protocol: { major: 1, minor: 0 },
  hostVersion: "0.1.0",
  capabilities: ["projects:list"],
} as const;

it.effect("negotiates before reading the authoritative Project list", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const transport: LocalTransport = {
      request: (request) => {
        requests.push(request.operation);
        return Effect.succeed(
          request.operation === "negotiate" ? handshake : { projects: [] },
        ) as never;
      },
      close: Effect.void,
    };

    const client = makeLocalClient({ connect: Effect.succeed(transport) });
    const overview = yield* client.getHostOverview;

    expect(overview).toEqual({ host: handshake, projects: [] });
    expect(requests).toEqual(["negotiate", "projects.list"]);
  }),
);

it.effect("stops before Project lifecycle work when the protocol major is incompatible", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const transport: LocalTransport = {
      request: (request) => {
        requests.push(request.operation);
        return Effect.succeed({
          ...handshake,
          protocol: { major: 2, minor: 0 },
        }) as never;
      },
      close: Effect.void,
    };

    const client = makeLocalClient({ connect: Effect.succeed(transport) });
    const error = yield* Effect.flip(client.getHostOverview);

    expect(error).toBeInstanceOf(IncompatibleProtocolError);
    expect(requests).toEqual(["negotiate"]);
  }),
);

it.effect("activates once and retries discovery within a bound", () =>
  Effect.gen(function* () {
    let attempts = 0;
    let activations = 0;
    const transport: LocalTransport = {
      request: (request) =>
        Effect.succeed(request.operation === "negotiate" ? handshake : { projects: [] }) as never,
      close: Effect.void,
    };
    const client = makeLocalClient({
      connect: Effect.suspend(() => {
        attempts += 1;
        return attempts < 3
          ? Effect.fail(new LocalTransportError({ message: "Kojo Host is unavailable." }))
          : Effect.succeed(transport);
      }),
      activate: Effect.sync(() => {
        activations += 1;
      }),
      retryDelay: "0 millis",
      maxAttempts: 3,
    });

    yield* client.getHostOverview;

    expect(attempts).toBe(3);
    expect(activations).toBe(1);
  }),
);

it.effect("returns a safe error when discovery remains unavailable", () =>
  Effect.gen(function* () {
    const client = makeLocalClient({
      connect: Effect.fail(new LocalTransportError({ message: "Kojo Host is unavailable." })),
      activate: Effect.void,
      retryDelay: "0 millis",
      maxAttempts: 2,
    });

    const error = yield* Effect.flip(client.getHostOverview);

    expect(error).toEqual(new LocalTransportError({ message: "Kojo Host is unavailable." }));
  }),
);
