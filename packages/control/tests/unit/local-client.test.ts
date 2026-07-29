import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  IncompatibleProtocolError,
  type KojoControlClient,
  LocalTransportError,
  makeLocalClient,
} from "../../src/local-client";

const handshake = {
  protocol: { major: 1, minor: 0 },
  hostVersion: "0.1.0",
  capabilities: ["projects:list"],
} as const;

const controlClient = (
  requests: Array<string>,
  host:
    | typeof handshake
    | { readonly protocol: { readonly major: 2; readonly minor: 0 } } = handshake,
) =>
  ({
    Negotiate: () => {
      requests.push("Negotiate");
      return Effect.succeed(host);
    },
    ListProjects: () => {
      requests.push("ListProjects");
      return Effect.succeed({ projects: [] });
    },
  }) as unknown as KojoControlClient;

it.effect("negotiates before reading the authoritative Project list", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];

    const client = makeLocalClient({ connect: Effect.succeed(controlClient(requests)) });
    const overview = yield* client.getHostOverview;

    expect(overview).toEqual({ host: handshake, projects: [] });
    expect(requests).toEqual(["Negotiate", "ListProjects"]);
  }),
);

it.effect("stops before Project lifecycle work when the protocol major is incompatible", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];

    const client = makeLocalClient({
      connect: Effect.succeed(controlClient(requests, { protocol: { major: 2, minor: 0 } })),
    });
    const error = yield* Effect.flip(client.getHostOverview);

    expect(error).toBeInstanceOf(IncompatibleProtocolError);
    expect(requests).toEqual(["Negotiate"]);
  }),
);

it.effect("activates once and retries discovery within a bound", () =>
  Effect.gen(function* () {
    let attempts = 0;
    let activations = 0;
    const transport = controlClient([]);
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
