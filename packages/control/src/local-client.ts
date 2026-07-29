import { BunSocket } from "@effect/platform-bun";
import { Data, Effect } from "effect";
import type * as Duration from "effect/Duration";
import type { Scope } from "effect/Scope";
import type { RpcGroup } from "effect/unstable/rpc";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Socket } from "effect/unstable/socket";
import { type HostOverview, KojoControl, PROTOCOL_VERSION } from "./index";

export class LocalTransportError extends Data.TaggedError("LocalTransportError")<{
  readonly message: string;
}> {}

export class IncompatibleProtocolError extends Data.TaggedError("IncompatibleProtocolError")<{
  readonly clientMajor: number;
  readonly hostMajor: number;
  readonly message: string;
}> {}

export type KojoControlClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof KojoControl>,
  RpcClientError
>;

export interface LocalClientOptions {
  readonly connect: Effect.Effect<KojoControlClient, LocalTransportError, Scope>;
  readonly activate?: Effect.Effect<void>;
  readonly maxAttempts?: number;
  readonly retryDelay?: Duration.Input;
}

const safeUnavailable = () => new LocalTransportError({ message: "Kojo Host is unavailable." });

export const makeLocalClient = (options: LocalClientOptions) => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const retryDelay = options.retryDelay ?? "50 millis";

  const exchange = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* options.connect;
      const host = yield* client.Negotiate().pipe(Effect.mapError(safeUnavailable));

      if (host.protocol.major !== PROTOCOL_VERSION.major) {
        return yield* Effect.fail(
          new IncompatibleProtocolError({
            clientMajor: PROTOCOL_VERSION.major,
            hostMajor: host.protocol.major,
            message: `Kojo Host protocol ${host.protocol.major} is incompatible with client protocol ${PROTOCOL_VERSION.major}.`,
          }),
        );
      }

      const { projects } = yield* client.ListProjects().pipe(Effect.mapError(safeUnavailable));
      return { host, projects };
    }),
  );

  const retryTransport = (
    attempt: number,
  ): Effect.Effect<HostOverview, LocalTransportError | IncompatibleProtocolError> =>
    exchange.pipe(
      Effect.catchTag("LocalTransportError", () => {
        if (attempt >= maxAttempts) return Effect.fail(safeUnavailable());
        const delay = retryDelay === "0 millis" ? Effect.void : Effect.sleep(retryDelay);
        return Effect.andThen(delay, retryTransport(attempt + 1));
      }),
    );

  const getHostOverview: Effect.Effect<
    HostOverview,
    LocalTransportError | IncompatibleProtocolError
  > = exchange.pipe(
    Effect.catchTag("LocalTransportError", () =>
      Effect.andThen(options.activate ?? Effect.void, retryTransport(2)),
    ),
  );

  return { getHostOverview } as const;
};

export const connectUnixControlClient = (socketPath: string) =>
  Effect.gen(function* () {
    const socket = yield* BunSocket.makeNet({ path: socketPath });
    const protocol = yield* RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
    }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.ndjson),
    );
    return yield* RpcClient.make(KojoControl).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
  }).pipe(Effect.mapError(safeUnavailable));

export const defaultSocketPath = () => {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  return runtimeDirectory === undefined
    ? `/tmp/kojo-${process.getuid?.() ?? 0}.sock`
    : `${runtimeDirectory}/kojo.sock`;
};

export const activateKojoHost = Effect.tryPromise({
  try: async () => {
    if (process.platform !== "darwin") return;
    const processHandle = Bun.spawn(
      ["launchctl", "kickstart", `gui/${process.getuid?.() ?? 0}/dev.kojo.host`],
      { stdout: "ignore", stderr: "ignore" },
    );
    await processHandle.exited;
  },
  catch: () => undefined,
}).pipe(Effect.ignore);

export const makeDefaultLocalClient = (socketPath = defaultSocketPath()) =>
  makeLocalClient({
    connect: connectUnixControlClient(socketPath),
    activate: activateKojoHost,
  });
