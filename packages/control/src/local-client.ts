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
  type ProjectWorkflowQueryResult,
  type RequestKey,
  type WorkflowDefinitionQueryResult,
  type WorkflowRunId,
  type WorkflowRunListInput,
  type WorkflowRunListResult,
  type WorkflowRunMutationResult,
  type WorkflowRunQueryResult,
  type WorkflowRunStartResult,
  type WorkflowScheduleListInput,
  type WorkflowScheduleListResult,
  type WorkflowScheduleMutationResult,
  type WorkflowScheduleQueryResult,
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

  const listProjects = activateAndRetry(
    request("projects:list", (client) => client.ListProjects()),
  ) satisfies Effect.Effect<ProjectList, LocalClientError>;

  const listProjectPage = (input: ProjectListInput = { conditions: [], limit: 50 }) =>
    activateAndRetry(
      request("projects:list-page", (client) => client.ListProjectPage(input)),
    ) satisfies Effect.Effect<ProjectListResult, LocalClientError>;

  const showProject = (identity: ProjectIdentity) =>
    activateAndRetry(request("projects:show", (client) => client.ShowProject({ identity })));
  const listWorkflowDefinitions = (identity: ProjectIdentity) =>
    activateAndRetry(
      request("workflows:list", (client) => client.ListWorkflowDefinitions({ identity })),
    );
  const showWorkflowDefinition = (identity: ProjectIdentity, workflowKey: string) =>
    activateAndRetry(
      request("workflows:show", (client) =>
        client.ShowWorkflowDefinition({ identity, workflowKey }),
      ),
    );
  const listWorkflowSchedules = (input: WorkflowScheduleListInput) =>
    activateAndRetry(request("schedules:list", (client) => client.ListWorkflowSchedules(input)));
  const showWorkflowSchedule = (identity: ProjectIdentity, scheduleKey: string) =>
    activateAndRetry(
      request("schedules:show", (client) => client.ShowWorkflowSchedule({ identity, scheduleKey })),
    );
  const listNextWorkflowSchedules = (input: WorkflowScheduleListInput) =>
    activateAndRetry(
      request("schedules:next", (client) => client.ListNextWorkflowSchedules(input)),
    );
  const enableWorkflowSchedule = (
    identity: ProjectIdentity,
    scheduleKey: string,
    scheduleRevision: string,
    requestKey: RequestKey,
  ) =>
    activateAndRetry(
      request("schedules:enable", (client) =>
        client.EnableWorkflowSchedule({ identity, scheduleKey, scheduleRevision, requestKey }),
      ),
    );
  const disableWorkflowSchedule = (
    identity: ProjectIdentity,
    scheduleKey: string,
    requestKey: RequestKey,
  ) =>
    activateAndRetry(
      request("schedules:disable", (client) =>
        client.DisableWorkflowSchedule({ identity, scheduleKey, requestKey }),
      ),
    );
  const startWorkflowRun = (
    identity: ProjectIdentity,
    workflowKey: string,
    workflowRevision: string,
    input: unknown,
    requestKey: RequestKey,
  ) =>
    activateAndRetry(
      request("runs:start", (client) =>
        client.StartWorkflowRun({ identity, workflowKey, workflowRevision, input, requestKey }),
      ),
    );
  const listWorkflowRuns = (input: WorkflowRunListInput) =>
    activateAndRetry(request("runs:list", (client) => client.ListWorkflowRuns(input)));
  const showWorkflowRun = (identity: ProjectIdentity, runId: WorkflowRunId) =>
    activateAndRetry(request("runs:show", (client) => client.ShowWorkflowRun({ identity, runId })));
  const revealWorkflowRun = (identity: ProjectIdentity, runId: WorkflowRunId) =>
    activateAndRetry(
      request("runs:reveal", (client) => client.RevealWorkflowRun({ identity, runId })),
    );
  const resumeWorkflowRun = (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    value: unknown,
    requestKey: RequestKey,
  ) =>
    activateAndRetry(
      request("runs:resume", (client) =>
        client.ResumeWorkflowRun({ identity, runId, value, requestKey }),
      ),
    );
  const completeWorkflowDeferred = (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    token: string,
    value: unknown,
    requestKey: RequestKey,
  ) =>
    activateAndRetry(
      request("runs:deferred-complete", (client) =>
        client.CompleteWorkflowDeferred({ identity, runId, token, value, requestKey }),
      ),
    );
  const getHostOverview = activateAndRetry(
    request("projects:list", (client, host) =>
      Effect.gen(function* () {
        const { projects } = yield* client.ListProjects();
        const definitions = host.capabilities.includes("workflows:list")
          ? yield* Effect.forEach(
              projects,
              (project) => client.ListWorkflowDefinitions({ identity: project.identity }),
              { concurrency: "unbounded" },
            )
          : [];
        const runs = host.capabilities.includes("runs:list")
          ? yield* Effect.forEach(
              projects,
              (project) =>
                client.ListWorkflowRuns({
                  identity: project.identity,
                  workflowKeys: [],
                  states: [],
                  limit: 20,
                }),
              { concurrency: "unbounded" },
            )
          : [];
        const schedules = host.capabilities.includes("schedules:list")
          ? yield* Effect.forEach(
              projects,
              (project) =>
                client.ListWorkflowSchedules({
                  identity: project.identity,
                  workflowKeys: [],
                  conditions: [],
                }),
              { concurrency: "unbounded" },
            )
          : [];
        return {
          host,
          projects,
          projectDefinitions: definitions.flatMap((result) => (result.ok ? [result.snapshot] : [])),
          workflowSchedules: schedules.flatMap((result, index) => {
            const project = projects[index];
            return result?.ok && project !== undefined
              ? [{ project, schedules: result.schedules }]
              : [];
          }),
          workflowRuns: runs.flatMap((result, index) => {
            const project = projects[index];
            return result?.ok && project !== undefined ? [{ project, runs: result.runs }] : [];
          }),
        } satisfies HostOverview;
      }),
    ),
  );
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
    listWorkflowDefinitions,
    showWorkflowDefinition,
    listWorkflowSchedules,
    showWorkflowSchedule,
    listNextWorkflowSchedules,
    enableWorkflowSchedule,
    disableWorkflowSchedule,
    startWorkflowRun,
    listWorkflowRuns,
    showWorkflowRun,
    revealWorkflowRun,
    resumeWorkflowRun,
    completeWorkflowDeferred,
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
    readonly listWorkflowDefinitions: (
      identity: ProjectIdentity,
    ) => Effect.Effect<
      ProjectWorkflowQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly showWorkflowDefinition: (
      identity: ProjectIdentity,
      workflowKey: string,
    ) => Effect.Effect<
      WorkflowDefinitionQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly listWorkflowSchedules: (
      input: WorkflowScheduleListInput,
    ) => Effect.Effect<
      WorkflowScheduleListResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly showWorkflowSchedule: (
      identity: ProjectIdentity,
      scheduleKey: string,
    ) => Effect.Effect<
      WorkflowScheduleQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly listNextWorkflowSchedules: (
      input: WorkflowScheduleListInput,
    ) => Effect.Effect<
      WorkflowScheduleListResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly enableWorkflowSchedule: (
      identity: ProjectIdentity,
      scheduleKey: string,
      scheduleRevision: string,
      requestKey: RequestKey,
    ) => Effect.Effect<
      WorkflowScheduleMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly disableWorkflowSchedule: (
      identity: ProjectIdentity,
      scheduleKey: string,
      requestKey: RequestKey,
    ) => Effect.Effect<
      WorkflowScheduleMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly startWorkflowRun: (
      identity: ProjectIdentity,
      workflowKey: string,
      workflowRevision: string,
      input: unknown,
      requestKey: RequestKey,
    ) => Effect.Effect<
      WorkflowRunStartResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly listWorkflowRuns: (
      input: WorkflowRunListInput,
    ) => Effect.Effect<
      WorkflowRunListResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly showWorkflowRun: (
      identity: ProjectIdentity,
      runId: WorkflowRunId,
    ) => Effect.Effect<
      WorkflowRunQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly revealWorkflowRun: (
      identity: ProjectIdentity,
      runId: WorkflowRunId,
    ) => Effect.Effect<
      WorkflowRunQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly resumeWorkflowRun: (
      identity: ProjectIdentity,
      runId: WorkflowRunId,
      value: unknown,
      requestKey: RequestKey,
    ) => Effect.Effect<
      WorkflowRunMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly completeWorkflowDeferred: (
      identity: ProjectIdentity,
      runId: WorkflowRunId,
      token: string,
      value: unknown,
      requestKey: RequestKey,
    ) => Effect.Effect<
      WorkflowRunMutationResult,
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
