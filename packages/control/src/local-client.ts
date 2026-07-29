import { Data, Effect, Exit, Schema } from "effect";
import type * as Duration from "effect/Duration";
import {
  type ControlRequest,
  type ControlResponse,
  HostInformation,
  type HostOverview,
  PROTOCOL_VERSION,
  ProjectList,
} from "./index";

export class LocalTransportError extends Data.TaggedError("LocalTransportError")<{
  readonly message: string;
}> {}

export class IncompatibleProtocolError extends Data.TaggedError("IncompatibleProtocolError")<{
  readonly clientMajor: number;
  readonly hostMajor: number;
  readonly message: string;
}> {}

export interface LocalTransport {
  readonly request: <Request extends ControlRequest>(
    request: Request,
  ) => Effect.Effect<ControlResponse<Request>, LocalTransportError>;
  readonly close: Effect.Effect<void>;
}

export interface LocalClientOptions {
  readonly connect: Effect.Effect<LocalTransport, LocalTransportError>;
  readonly activate?: Effect.Effect<void>;
  readonly maxAttempts?: number;
  readonly retryDelay?: Duration.Input;
}

const safeUnavailable = () => new LocalTransportError({ message: "Kojo Host is unavailable." });

export const makeLocalClient = (options: LocalClientOptions) => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const retryDelay = options.retryDelay ?? "50 millis";

  const discover = Effect.gen(function* () {
    const initial = yield* Effect.exit(options.connect);
    if (Exit.isSuccess(initial)) return initial.value;

    yield* options.activate ?? Effect.void;

    let attempt = 1;
    while (attempt < maxAttempts) {
      if (retryDelay !== "0 millis") yield* Effect.sleep(retryDelay);
      const next = yield* Effect.exit(options.connect);
      if (Exit.isSuccess(next)) return next.value;
      attempt += 1;
    }

    return yield* Effect.fail(safeUnavailable());
  });

  const getHostOverview: Effect.Effect<
    HostOverview,
    LocalTransportError | IncompatibleProtocolError
  > = Effect.acquireUseRelease(
    discover,
    (transport) =>
      Effect.gen(function* () {
        const host = yield* transport.request({ operation: "negotiate" });

        if (host.protocol.major !== PROTOCOL_VERSION.major) {
          return yield* Effect.fail(
            new IncompatibleProtocolError({
              clientMajor: PROTOCOL_VERSION.major,
              hostMajor: host.protocol.major,
              message: `Kojo Host protocol ${host.protocol.major} is incompatible with client protocol ${PROTOCOL_VERSION.major}. Upgrade Kojo Host or this client.`,
            }),
          );
        }

        const { projects } = yield* transport.request({ operation: "projects.list" });
        return { host, projects };
      }),
    (transport) => transport.close,
  );

  return { getHostOverview } as const;
};

interface SocketState {
  buffer: string;
  pending?: {
    resolve: (value: unknown) => void;
    reject: () => void;
  };
}

export const connectUnixTransport = (
  socketPath: string,
): Effect.Effect<LocalTransport, LocalTransportError> =>
  Effect.tryPromise({
    try: async () => {
      const state: SocketState = { buffer: "" };
      const socket = await Bun.connect<SocketState>({
        unix: socketPath,
        socket: {
          open(openSocket) {
            openSocket.data = state;
          },
          data(openSocket, bytes) {
            const current = openSocket.data;
            current.buffer += new TextDecoder().decode(bytes);
            const newline = current.buffer.indexOf("\n");
            if (newline < 0 || current.pending === undefined) return;

            const line = current.buffer.slice(0, newline);
            current.buffer = current.buffer.slice(newline + 1);
            const pending = current.pending;
            current.pending = undefined;
            try {
              pending.resolve(JSON.parse(line));
            } catch {
              pending.reject();
            }
          },
          close(openSocket) {
            openSocket.data.pending?.reject();
          },
          error(openSocket) {
            openSocket.data.pending?.reject();
          },
        },
      });

      return {
        request: <Request extends ControlRequest>(request: Request) =>
          Effect.tryPromise({
            try: () =>
              new Promise<ControlResponse<Request>>((resolve, reject) => {
                state.pending = {
                  resolve: (value) => {
                    try {
                      const decoded =
                        request.operation === "negotiate"
                          ? Schema.decodeUnknownSync(HostInformation)(value)
                          : Schema.decodeUnknownSync(ProjectList)(value);
                      resolve(decoded as ControlResponse<Request>);
                    } catch {
                      reject();
                    }
                  },
                  reject,
                };
                socket.write(`${JSON.stringify(request)}\n`);
                socket.flush();
              }),
            catch: safeUnavailable,
          }),
        close: Effect.sync(() => socket.end()),
      } satisfies LocalTransport;
    },
    catch: safeUnavailable,
  });

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
    connect: connectUnixTransport(socketPath),
    activate: activateKojoHost,
  });
