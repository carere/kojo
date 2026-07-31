import { createConnection, type Socket as NetSocket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { BunSocket } from "@effect/platform-bun";
import { Data, Deferred, Effect, Stream } from "effect";
import type * as Duration from "effect/Duration";
import type { Scope as ScopeType } from "effect/Scope";
import type { RpcGroup } from "effect/unstable/rpc";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
  type FromClientEncoded,
  type FromServerEncoded,
  RequestId,
  type RequestId as RpcRequestId,
} from "effect/unstable/rpc/RpcMessage";
import { Socket } from "effect/unstable/socket";
import {
  type ControlCapability,
  type ControlSubscriptionAcknowledgement,
  type ControlSubscriptionDelivery,
  type ControlSubscriptionInput,
  type ControlSubscriptionUpdate,
  type ExecutionArtifactDownloadInput,
  type ExecutionArtifactDownloadResult,
  type ExecutionTraceExportInput,
  type ExecutionTraceExportResult,
  type ExecutionTraceQueryResult,
  type ExecutionTraceReadInput,
  type HostOverview,
  KojoControl,
  PROTOCOL_VERSION,
  type ProjectIdentity,
  type ProjectList,
  type ProjectListInput,
  type ProjectListResult,
  type ProjectMutationResult,
  type ProjectQueryResult,
  type ProjectReadinessActionKey,
  type ProjectReadinessQueryResult,
  type ProjectReadinessRepairResult,
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
  type WorkflowScheduleOccurrenceListInput,
  type WorkflowScheduleOccurrenceListResult,
  type WorkflowScheduleOccurrenceQueryResult,
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

/** A client connection can detach its transport before its Effect Scope closes. */
export interface LocalControlConnection {
  readonly client: KojoControlClient;
  readonly disconnect: Effect.Effect<void>;
}

export interface LocalClientOptions {
  readonly connect: Effect.Effect<
    KojoControlClient | LocalControlConnection,
    LocalTransportError,
    ScopeType
  >;
  readonly activate?: Effect.Effect<void, LocalTransportError>;
  readonly maxAttempts?: number;
  readonly retryDelay?: Duration.Input;
}

export interface OperatingSystemHostActivationOptions {
  readonly activationTimeout?: Duration.Input;
  readonly platform: NodeJS.Platform;
  readonly run: (command: ReadonlyArray<string>, signal: AbortSignal) => Promise<number>;
  readonly userId: number;
}

const safeUnavailable = () => new LocalTransportError({ message: "Kojo Host is unavailable." });

const asLocalControlConnection = (
  connection: KojoControlClient | LocalControlConnection,
): LocalControlConnection =>
  "client" in connection && "disconnect" in connection
    ? connection
    : { client: connection, disconnect: Effect.void };

type DestroyableUnixSocket = Pick<NetSocket, "destroy" | "destroyed">;
type DisconnectableUnixSocket = DestroyableUnixSocket & Pick<NetSocket, "end" | "off" | "once">;
const controlConnectionEof: FromClientEncoded = { _tag: "Eof" };
/** A real transport deadline: it must not depend on an application's Effect Clock. */
export const UNIX_CONTROL_DISCONNECT_GRACE_MS = 100;

interface UnixControlTerminalWait {
  readonly await: Effect.Effect<void>;
  readonly interruptRequestIds: ReadonlySet<RpcRequestId>;
  readonly requestIds: ReadonlySet<RpcRequestId>;
}

interface UnixControlTerminalWaitState {
  readonly deferred: Deferred.Deferred<void>;
  readonly requestIds: Set<RpcRequestId>;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

/** @internal Tracks active requests and terminal replies for one Unix connection. */
export interface UnixControlRequestRegistry {
  readonly active: ReadonlySet<RpcRequestId>;
  readonly add: (requestId: RpcRequestId) => void;
  readonly clear: () => void;
  readonly delete: (requestId: RpcRequestId) => void;
  readonly interrupted: (requestId: RpcRequestId) => void;
  readonly terminal: (requestId: RpcRequestId) => void;
  readonly beginTerminalWait: () => Effect.Effect<UnixControlTerminalWait>;
}

/** @internal Keeps bounded disconnect acknowledgement state local to one protocol. */
export const makeUnixControlRequestRegistry = (): UnixControlRequestRegistry => {
  const active = new Set<RpcRequestId>();
  const interrupted = new Set<RpcRequestId>();
  const waits = new Set<UnixControlTerminalWaitState>();

  const finish = (wait: UnixControlTerminalWaitState) => {
    if (!waits.delete(wait)) return;
    if (wait.timeout !== undefined) clearTimeout(wait.timeout);
    Deferred.doneUnsafe(wait.deferred, Effect.void);
  };

  return {
    active,
    add: (requestId) => {
      active.add(requestId);
      interrupted.delete(requestId);
    },
    clear: () => {
      active.clear();
      interrupted.clear();
      for (const wait of [...waits]) finish(wait);
    },
    delete: (requestId) => {
      active.delete(requestId);
      interrupted.delete(requestId);
    },
    interrupted: (requestId) => {
      if (active.has(requestId)) interrupted.add(requestId);
    },
    terminal: (requestId) => {
      active.delete(requestId);
      interrupted.delete(requestId);
      for (const wait of [...waits]) {
        wait.requestIds.delete(requestId);
        if (wait.requestIds.size === 0) finish(wait);
      }
    },
    beginTerminalWait: () =>
      Effect.sync(() => {
        const requestIds = new Set(active);
        const wait: UnixControlTerminalWaitState = {
          deferred: Deferred.makeUnsafe<void>(),
          requestIds,
          timeout: undefined,
        };
        if (requestIds.size === 0) {
          Deferred.doneUnsafe(wait.deferred, Effect.void);
        } else {
          waits.add(wait);
          wait.timeout = setTimeout(() => finish(wait), UNIX_CONTROL_DISCONNECT_GRACE_MS);
        }
        return {
          interruptRequestIds: new Set(
            [...requestIds].filter((requestId) => !interrupted.has(requestId)),
          ),
          requestIds,
          await: Deferred.await(wait.deferred).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                finish(wait);
              }),
            ),
          ),
        };
      }),
  };
};

/** Let the peer schedule received interrupt frames before its socket sees Eof. */
const yieldUnixControlInterrupts = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve)),
);

const destroyUnixControlConnection = (connection: DestroyableUnixSocket) =>
  Effect.sync(() => {
    if (!connection.destroyed) connection.destroy();
  });

/** Flush the terminal frame and wait a bounded time for the peer-visible close. */
export const closeUnixControlSocket = (connection: DisconnectableUnixSocket) =>
  Effect.callback<void>((resume, signal) => {
    if (connection.destroyed) {
      resume(Effect.void);
      return;
    }
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (force: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      connection.off("close", onClose);
      if (force && !connection.destroyed) connection.destroy();
      resume(Effect.void);
    };
    const onClose = () => settle(false);
    const onAbort = () => settle(true);
    connection.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => settle(true), UNIX_CONTROL_DISCONNECT_GRACE_MS);
    connection.end();
    return Effect.sync(() => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      connection.off("close", onClose);
    });
  });

/** @internal Sends stream interrupts before graceful Eof and bounded close. */
export const disconnectUnixControlConnection = (
  connection: NetSocket,
  protocol: RpcClient.Protocol["Service"],
  requestRegistry: UnixControlRequestRegistry,
) =>
  Effect.gen(function* () {
    const terminalWait = yield* requestRegistry.beginTerminalWait();
    yield* Effect.forEach(
      terminalWait.interruptRequestIds,
      (requestId) => protocol.send(0, { _tag: "Interrupt", requestId }).pipe(Effect.ignore),
      { discard: true },
    );
    yield* terminalWait.await;
    yield* yieldUnixControlInterrupts;
    yield* protocol.send(0, controlConnectionEof).pipe(Effect.ignore);
    yield* closeUnixControlSocket(connection);
  });

/** @internal Tracks only live RPC requests for one Unix control connection. */
export const trackUnixControlProtocol = (
  protocol: RpcClient.Protocol["Service"],
  requestRegistry: UnixControlRequestRegistry,
): RpcClient.Protocol["Service"] => {
  const completeResponse = (response: FromServerEncoded) =>
    Effect.sync(() => {
      if (response._tag === "Exit") requestRegistry.terminal(RequestId(response.requestId));
      // `ClientEnd` is not emitted by beta.102's socket decoder, but accept
      // it if a future/custom Protocol supplies it through this seam.
      const tag: string = response._tag;
      if (tag === "Defect" || tag === "ClientProtocolError" || tag === "ClientEnd") {
        requestRegistry.clear();
      }
    });
  return {
    ...protocol,
    run: (clientId, receive) =>
      protocol.run(clientId, (response) =>
        receive(response).pipe(Effect.ensuring(completeResponse(response))),
      ),
    send: (clientId, request, transferables) => {
      switch (request._tag) {
        case "Request": {
          const requestId = RequestId(request.id);
          requestRegistry.add(requestId);
          return protocol
            .send(clientId, request, transferables)
            .pipe(Effect.onError(() => Effect.sync(() => requestRegistry.delete(requestId))));
        }
        case "Interrupt": {
          const requestId = RequestId(request.requestId);
          return protocol
            .send(clientId, request, transferables)
            .pipe(Effect.tap(() => Effect.sync(() => requestRegistry.interrupted(requestId))));
        }
        default:
          return protocol.send(clientId, request, transferables);
      }
    },
  };
};

/** @internal Registers an eager transport detach after RPC resources exist. */
export const registerUnixControlDisconnectFinalizer = (connection: DestroyableUnixSocket) =>
  Effect.addFinalizer(() => destroyUnixControlConnection(connection));

/**
 * The Unix control boundary has to detach an ended subscription immediately.
 * The platform's generic net connector uses `destroySoon`, which leaves an
 * idle read-side connection alive during Host shutdown. Own this narrow raw
 * connection in the caller's Scope and destroy it on release instead.
 */
const openUnixControlConnection = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<NetSocket, Socket.SocketError>((resume) => {
      const connection = createConnection({ path });
      const onConnect = () => {
        connection.off("error", onError);
        resume(Effect.succeed(connection));
      };
      const onError = (cause: Error) => {
        connection.off("connect", onConnect);
        resume(
          Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
            }),
          ),
        );
      };
      connection.once("connect", onConnect);
      connection.once("error", onError);
      return Effect.andThen(
        Effect.sync(() => {
          connection.off("connect", onConnect);
          connection.off("error", onError);
        }),
        destroyUnixControlConnection(connection),
      );
    }),
    destroyUnixControlConnection,
  );

export const makeLocalClient = (options: LocalClientOptions) => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const retryDelay = options.retryDelay ?? "50 millis";

  const negotiateCapability = (
    client: KojoControlClient,
    capability: ControlCapability,
  ): Effect.Effect<HostOverview["host"], LocalClientError> =>
    Effect.gen(function* () {
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
      return host;
    });

  const request = <A>(
    capability: ControlCapability,
    operation: (
      client: KojoControlClient,
      host: HostOverview["host"],
    ) => Effect.Effect<A, RpcClientError>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = asLocalControlConnection(yield* options.connect);
        return yield* Effect.gen(function* () {
          const host = yield* negotiateCapability(connection.client, capability);
          return yield* operation(connection.client, host).pipe(Effect.mapError(safeUnavailable));
        }).pipe(Effect.ensuring(connection.disconnect));
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
  const showProjectReadiness = (identity: ProjectIdentity) =>
    activateAndRetry(
      request("readiness:show", (client) => client.ShowProjectReadiness({ identity })),
    );
  const refreshProjectReadiness = (identity: ProjectIdentity) =>
    activateAndRetry(
      request("readiness:refresh", (client) => client.RefreshProjectReadiness({ identity })),
    );
  const repairProjectReadiness = (
    identity: ProjectIdentity,
    assessmentRevision: string,
    action: ProjectReadinessActionKey,
    requestKey: RequestKey,
  ) =>
    activateAndRetry(
      request("readiness:repair", (client) =>
        client.RepairProjectReadiness({ identity, assessmentRevision, action, requestKey }),
      ),
    );
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
  const listWorkflowScheduleOccurrences = (input: WorkflowScheduleOccurrenceListInput) =>
    activateAndRetry(
      request("occurrences:list", (client) => client.ListWorkflowScheduleOccurrences(input)),
    );
  const showWorkflowScheduleOccurrence = (
    identity: ProjectIdentity,
    scheduleKey: string,
    scheduledAtMs: number,
  ) =>
    activateAndRetry(
      request("occurrences:show", (client) =>
        client.ShowWorkflowScheduleOccurrence({ identity, scheduleKey, scheduledAtMs }),
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
  const readExecutionTrace = (input: ExecutionTraceReadInput) =>
    activateAndRetry(request("traces:read", (client) => client.ReadExecutionTrace(input)));
  const exportExecutionTrace = (input: ExecutionTraceExportInput) =>
    activateAndRetry(request("traces:export", (client) => client.ExportExecutionTrace(input)));
  const downloadExecutionArtifact = (input: ExecutionArtifactDownloadInput) =>
    activateAndRetry(
      request("artifacts:read", (client) => client.DownloadExecutionArtifact(input)),
    );
  const subscribeControl = (input: ControlSubscriptionInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Effect beta.102 gives unwrap the channel scope, so the RPC stream
        // can register its interrupt finalizer in the same lifecycle.
        const connection = asLocalControlConnection(yield* options.connect);
        yield* negotiateCapability(connection.client, "control:subscribe");
        return connection.client
          .SubscribeControl(input, { streamBufferSize: 32 })
          .pipe(Stream.mapError(safeUnavailable), Stream.ensuring(connection.disconnect));
      }),
    );
  const acknowledgeControlSubscription = (delivery: ControlSubscriptionDelivery) =>
    activateAndRetry(
      request("control:acknowledge", (client) => client.AcknowledgeControlSubscription(delivery)),
    ) satisfies Effect.Effect<ControlSubscriptionAcknowledgement, LocalClientError>;
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
  const stopWorkflowRun = (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    requestKey: RequestKey,
  ) =>
    activateAndRetry(
      request("runs:stop", (client) => client.StopWorkflowRun({ identity, runId, requestKey })),
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
        const readiness = host.capabilities.includes("readiness:show")
          ? yield* Effect.forEach(
              projects,
              (project) => client.ShowProjectReadiness({ identity: project.identity }),
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
        const occurrences = host.capabilities.includes("occurrences:list")
          ? yield* Effect.forEach(
              projects,
              (project) =>
                client.ListWorkflowScheduleOccurrences({
                  identity: project.identity,
                  scheduleKeys: [],
                  outcomes: [],
                  limit: 20,
                }),
              { concurrency: "unbounded" },
            )
          : [];
        return {
          host,
          projects,
          readiness: readiness.flatMap((result) => (result.ok ? [result.assessment] : [])),
          projectDefinitions: definitions.flatMap((result) => (result.ok ? [result.snapshot] : [])),
          workflowSchedules: schedules.flatMap((result, index) => {
            const project = projects[index];
            return result?.ok && project !== undefined
              ? [{ project, schedules: result.schedules }]
              : [];
          }),
          workflowOccurrences: occurrences.flatMap((result, index) => {
            const project = projects[index];
            return result?.ok && project !== undefined
              ? [{ project, occurrences: result.occurrences }]
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
    showProjectReadiness,
    refreshProjectReadiness,
    repairProjectReadiness,
    listWorkflowDefinitions,
    showWorkflowDefinition,
    listWorkflowSchedules,
    showWorkflowSchedule,
    listNextWorkflowSchedules,
    enableWorkflowSchedule,
    disableWorkflowSchedule,
    listWorkflowScheduleOccurrences,
    showWorkflowScheduleOccurrence,
    startWorkflowRun,
    listWorkflowRuns,
    showWorkflowRun,
    revealWorkflowRun,
    readExecutionTrace,
    exportExecutionTrace,
    downloadExecutionArtifact,
    subscribeControl,
    acknowledgeControlSubscription,
    resumeWorkflowRun,
    completeWorkflowDeferred,
    stopWorkflowRun,
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
    readonly showProjectReadiness: (
      identity: ProjectIdentity,
    ) => Effect.Effect<
      ProjectReadinessQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly refreshProjectReadiness: (
      identity: ProjectIdentity,
    ) => Effect.Effect<
      ProjectReadinessQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly repairProjectReadiness: (
      identity: ProjectIdentity,
      assessmentRevision: string,
      action: ProjectReadinessActionKey,
      requestKey: RequestKey,
    ) => Effect.Effect<
      ProjectReadinessRepairResult,
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
    readonly listWorkflowScheduleOccurrences: (
      input: WorkflowScheduleOccurrenceListInput,
    ) => Effect.Effect<
      WorkflowScheduleOccurrenceListResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly showWorkflowScheduleOccurrence: (
      identity: ProjectIdentity,
      scheduleKey: string,
      scheduledAtMs: number,
    ) => Effect.Effect<
      WorkflowScheduleOccurrenceQueryResult,
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
    readonly readExecutionTrace: (
      input: ExecutionTraceReadInput,
    ) => Effect.Effect<
      ExecutionTraceQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly exportExecutionTrace: (
      input: ExecutionTraceExportInput,
    ) => Effect.Effect<
      ExecutionTraceExportResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly downloadExecutionArtifact: (
      input: ExecutionArtifactDownloadInput,
    ) => Effect.Effect<
      ExecutionArtifactDownloadResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly subscribeControl: (
      input: ControlSubscriptionInput,
    ) => Stream.Stream<
      ControlSubscriptionUpdate,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >;
    readonly acknowledgeControlSubscription: (
      delivery: ControlSubscriptionDelivery,
    ) => Effect.Effect<
      ControlSubscriptionAcknowledgement,
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
    readonly stopWorkflowRun: (
      identity: ProjectIdentity,
      runId: WorkflowRunId,
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

export const connectUnixControlConnection = (socketPath: string) =>
  Effect.gen(function* () {
    const connection = yield* openUnixControlConnection(socketPath);
    const socket = yield* BunSocket.fromDuplex(Effect.succeed(connection));
    const socketProtocol = yield* RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
    }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.ndjson),
    );
    const requestRegistry = makeUnixControlRequestRegistry();
    const protocol = trackUnixControlProtocol(socketProtocol, requestRegistry);
    const client = yield* RpcClient.make(KojoControl).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    // This finalizer is registered after the RPC protocol and its background
    // read fiber. Scope finalization is LIFO, so destroy unblocks that fiber
    // before its own cleanup can wait on an idle Unix transport.
    yield* registerUnixControlDisconnectFinalizer(connection);
    return {
      client,
      disconnect: disconnectUnixControlConnection(connection, protocol, requestRegistry),
    };
  }).pipe(Effect.mapError(safeUnavailable));

export const connectUnixControlClient = (socketPath: string) =>
  connectUnixControlConnection(socketPath).pipe(Effect.map((connection) => connection.client));

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
    try: async (signal) => {
      const command = activationCommand(options.platform, options.userId);
      if (command === undefined) {
        throw new LocalTransportError({
          message: `Kojo Host activation is unsupported on ${options.platform}.`,
        });
      }
      try {
        await options.run(command, signal);
      } catch {
        // Activation is a best-effort wake-up. Discovery still performs its bounded retries.
      }
    },
    catch: (error) => (error instanceof LocalTransportError ? error : safeUnavailable()),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.activationTimeout ?? "1 second",
      orElse: () => Effect.void,
    }),
  );

export const activateKojoHost = makeOperatingSystemHostActivation({
  platform: process.platform,
  userId: process.getuid?.() ?? 0,
  run: async (command, signal) => {
    const processHandle = Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
    signal.addEventListener(
      "abort",
      () => {
        if (processHandle.exitCode === null) processHandle.kill("SIGTERM");
      },
      { once: true },
    );
    return processHandle.exited;
  },
});

export const makeDefaultLocalClient = (socketPath = defaultSocketPath()) =>
  makeLocalClient({
    connect: connectUnixControlConnection(socketPath),
    activate: activateKojoHost,
  });

export const makeNonActivatingLocalClient = (socketPath = defaultSocketPath()) =>
  makeLocalClient({
    connect: connectUnixControlConnection(socketPath),
    maxAttempts: 1,
  });
