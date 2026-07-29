import { homedir } from "node:os";
import { join } from "node:path";
import { BunSocket } from "@effect/platform-bun";
import { Data, Effect } from "effect";
import type * as Duration from "effect/Duration";
import type { Scope } from "effect/Scope";
import type { RpcGroup } from "effect/unstable/rpc";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Socket } from "effect/unstable/socket";
import {
  type HostOverview,
  KojoControl,
  PROTOCOL_VERSION,
  type ProjectIdentity,
  type ProjectList,
  type ProjectOperationResult,
} from "./index";

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
  readonly activate?: Effect.Effect<void, LocalTransportError>;
  readonly maxAttempts?: number;
  readonly retryDelay?: Duration.Input;
}

export interface OperatingSystemHostActivationOptions {
  readonly platform: NodeJS.Platform;
  readonly run: (command: ReadonlyArray<string>) => Promise<number>;
  readonly userId: number;
}

const safeUnavailable = () => new LocalTransportError({ message: "Kojo Host is unavailable." });

export const makeLocalClient = (options: LocalClientOptions) => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const retryDelay = options.retryDelay ?? "50 millis";

  const request = <A>(
    operation: (
      client: KojoControlClient,
      host: HostOverview["host"],
    ) => Effect.Effect<A, RpcClientError>,
  ) =>
    Effect.scoped(
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

        return yield* operation(client, host).pipe(Effect.mapError(safeUnavailable));
      }),
    );

  const retryTransport = <A>(
    effect: Effect.Effect<A, LocalTransportError | IncompatibleProtocolError>,
    attempt: number,
  ): Effect.Effect<A, LocalTransportError | IncompatibleProtocolError> =>
    effect.pipe(
      Effect.catchTag("LocalTransportError", () => {
        if (attempt >= maxAttempts) return Effect.fail(safeUnavailable());
        const delay = retryDelay === "0 millis" ? Effect.void : Effect.sleep(retryDelay);
        return Effect.andThen(delay, retryTransport(effect, attempt + 1));
      }),
    );

  const activateAndRetry = <A>(
    effect: Effect.Effect<A, LocalTransportError | IncompatibleProtocolError>,
  ) =>
    effect.pipe(
      Effect.catchTag("LocalTransportError", () =>
        Effect.andThen(options.activate ?? Effect.void, retryTransport(effect, 2)),
      ),
    );

  const getHostOverview = activateAndRetry(
    request((client, host) =>
      Effect.gen(function* () {
        const { projects } = yield* client.ListProjects();
        return { host, projects } satisfies HostOverview;
      }),
    ),
  );

  const listProjects = activateAndRetry(
    request((client) => client.ListProjects()),
  ) satisfies Effect.Effect<ProjectList, LocalTransportError | IncompatibleProtocolError>;

  const showProject = (identity: ProjectIdentity) =>
    activateAndRetry(request((client) => client.ShowProject({ identity })));
  const registerProject = (path: string) =>
    activateAndRetry(request((client) => client.RegisterProject({ path })));
  const forgetProject = (identity: ProjectIdentity) =>
    activateAndRetry(request((client) => client.ForgetProject({ identity })));

  return {
    getHostOverview,
    listProjects,
    showProject,
    registerProject,
    forgetProject,
  } satisfies {
    readonly getHostOverview: Effect.Effect<
      HostOverview,
      LocalTransportError | IncompatibleProtocolError
    >;
    readonly listProjects: Effect.Effect<
      ProjectList,
      LocalTransportError | IncompatibleProtocolError
    >;
    readonly showProject: (
      identity: ProjectIdentity,
    ) => Effect.Effect<ProjectOperationResult, LocalTransportError | IncompatibleProtocolError>;
    readonly registerProject: (
      path: string,
    ) => Effect.Effect<ProjectOperationResult, LocalTransportError | IncompatibleProtocolError>;
    readonly forgetProject: (
      identity: ProjectIdentity,
    ) => Effect.Effect<ProjectOperationResult, LocalTransportError | IncompatibleProtocolError>;
  };
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
    ? join(homedir(), ".kojo", "run", "control.sock")
    : join(runtimeDirectory, "kojo", "control.sock");
};

const activationCommand = (platform: NodeJS.Platform, userId: number) => {
  if (platform === "darwin") {
    return ["launchctl", "kickstart", `gui/${userId}/dev.kojo.host`] as const;
  }
  if (platform === "linux") {
    return ["systemctl", "--user", "start", "kojo-host.service"] as const;
  }
  return undefined;
};

export const makeOperatingSystemHostActivation = (
  options: OperatingSystemHostActivationOptions,
): Effect.Effect<void, LocalTransportError> =>
  Effect.tryPromise({
    try: async () => {
      const command = activationCommand(options.platform, options.userId);
      if (command === undefined) {
        throw new LocalTransportError({
          message: `Kojo Host activation is unsupported on ${options.platform}.`,
        });
      }
      try {
        await options.run(command);
      } catch {
        // Activation is a best-effort wake-up. Discovery still performs its bounded retries.
      }
    },
    catch: (error) => (error instanceof LocalTransportError ? error : safeUnavailable()),
  });

export const activateKojoHost = makeOperatingSystemHostActivation({
  platform: process.platform,
  userId: process.getuid?.() ?? 0,
  run: async (command) => {
    const processHandle = Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
    return processHandle.exited;
  },
});

export const makeDefaultLocalClient = (socketPath = defaultSocketPath()) =>
  makeLocalClient({
    connect: connectUnixControlClient(socketPath),
    activate: activateKojoHost,
  });
