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
  type ControlCapability,
  type HostOverview,
  KojoControl,
  PROTOCOL_VERSION,
  type ProjectIdentity,
  type ProjectList,
  type ProjectListInput,
  type ProjectListResult,
  type ProjectMutationResult,
  type ProjectQueryResult,
  type ProjectSelector,
  type RequestKey,
} from "./index";

export class LocalTransportError extends Data.TaggedError("LocalTransportError")<{
  readonly message: string;
}> {}

export class IncompatibleProtocolError extends Data.TaggedError("IncompatibleProtocolError")<{
  readonly clientMajor: number;
  readonly hostMajor: number;
  readonly message: string;
}> {}

export class UnsupportedControlCapabilityError extends Data.TaggedError(
  "UnsupportedControlCapabilityError",
)<{
  readonly capability: ControlCapability;
  readonly hostVersion: string;
  readonly message: string;
}> {}

type LocalClientError =
  | IncompatibleProtocolError
  | LocalTransportError
  | UnsupportedControlCapabilityError;

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
    capability: ControlCapability,
    operation: (
      client: KojoControlClient,
      host: HostOverview["host"],
    ) => Effect.Effect<A, RpcClientError>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* options.connect;
        const legacyHost = yield* client.Negotiate().pipe(Effect.mapError(safeUnavailable));

        if (legacyHost.protocol.major !== PROTOCOL_VERSION.major) {
          return yield* Effect.fail(
            new IncompatibleProtocolError({
              clientMajor: PROTOCOL_VERSION.major,
              hostMajor: legacyHost.protocol.major,
              message: `Kojo Host protocol ${legacyHost.protocol.major} is incompatible with client protocol ${PROTOCOL_VERSION.major}.`,
            }),
          );
        }
        const host =
          legacyHost.protocol.minor >= 1
            ? yield* client.NegotiateCapabilities().pipe(Effect.mapError(safeUnavailable))
            : legacyHost;
        if (!host.capabilities.includes(capability)) {
          return yield* Effect.fail(
            new UnsupportedControlCapabilityError({
              capability,
              hostVersion: host.hostVersion,
              message: `Kojo Host ${host.hostVersion} does not support ${capability}. Upgrade the Host or use a supported client operation.`,
            }),
          );
        }

        return yield* operation(client, host).pipe(Effect.mapError(safeUnavailable));
      }),
    );

  const retryTransport = <A>(
    effect: Effect.Effect<A, LocalClientError>,
    attempt: number,
  ): Effect.Effect<A, LocalClientError> =>
    effect.pipe(
      Effect.catchTag("LocalTransportError", () => {
        if (attempt >= maxAttempts) return Effect.fail(safeUnavailable());
        const delay = retryDelay === "0 millis" ? Effect.void : Effect.sleep(retryDelay);
        return Effect.andThen(delay, retryTransport(effect, attempt + 1));
      }),
    );

  const activateAndRetry = <A>(effect: Effect.Effect<A, LocalClientError>) =>
    effect.pipe(
      Effect.catchTag("LocalTransportError", () =>
        Effect.andThen(options.activate ?? Effect.void, retryTransport(effect, 2)),
      ),
    );

  const getHostOverview = activateAndRetry(
    request("projects:list", (client, host) =>
      Effect.gen(function* () {
        const { projects } = yield* client.ListProjects();
        return { host, projects } satisfies HostOverview;
      }),
    ),
  );

  const listProjects = activateAndRetry(
    request("projects:list", (client) => client.ListProjects()),
  ) satisfies Effect.Effect<ProjectList, LocalClientError>;

  const listProjectPage = (input: ProjectListInput = { conditions: [], limit: 50 }) =>
    activateAndRetry(
      request("projects:list-page", (client) => client.ListProjectPage(input)),
    ) satisfies Effect.Effect<ProjectListResult, LocalClientError>;

  const showProject = (identity: ProjectIdentity) =>
    activateAndRetry(request("projects:show", (client) => client.ShowProject({ identity })));
  const registerProject = (path: string, requestKey: RequestKey) =>
    activateAndRetry(
      request("projects:register", (client) => client.RegisterProject({ path, requestKey })),
    );
  const forgetProject = (
    identity: ProjectIdentity,
    selector: ProjectSelector,
    requestKey: RequestKey,
  ) =>
    activateAndRetry(
      request("projects:forget", (client) =>
        client.ForgetProject({ identity, selector, requestKey }),
      ),
    );
  const replayForgetProject = (selector: ProjectSelector, requestKey: RequestKey) =>
    activateAndRetry(
      request("projects:forget", (client) => client.ReplayForgetProject({ selector, requestKey })),
    );

  return {
    getHostOverview,
    listProjects,
    listProjectPage,
    showProject,
    registerProject,
    forgetProject,
    replayForgetProject,
  } satisfies {
    readonly getHostOverview: Effect.Effect<
      HostOverview,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly listProjects: Effect.Effect<
      ProjectList,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly listProjectPage: (
      input?: ProjectListInput,
    ) => Effect.Effect<
      ProjectListResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly showProject: (
      identity: ProjectIdentity,
    ) => Effect.Effect<
      ProjectQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly registerProject: (
      path: string,
      requestKey: RequestKey,
    ) => Effect.Effect<
      ProjectMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly forgetProject: (
      identity: ProjectIdentity,
      selector: ProjectSelector,
      requestKey: RequestKey,
    ) => Effect.Effect<
      ProjectMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly replayForgetProject: (
      selector: ProjectSelector,
      requestKey: RequestKey,
    ) => Effect.Effect<
      ProjectMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
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

export const makeNonActivatingLocalClient = (socketPath = defaultSocketPath()) =>
  makeLocalClient({
    connect: connectUnixControlClient(socketPath),
    maxAttempts: 1,
  });
