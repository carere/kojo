import { randomUUID } from "node:crypto";
import { chmod, open, readFile, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import {
  type DeletionResult,
  type DeletionScope,
  type ExecutionArtifactDownloadResult,
  type ExecutionTraceExportResult,
  type ExecutionTraceQueryResult,
  KojoControl,
  type ProjectIdentity,
  type ProjectMutationResult,
  type ProjectOperationErrorCode,
  type ProjectReadinessQueryResult,
  type ProjectReadinessRepairResult,
  type ProjectRetentionMutationResult,
  type ProjectRetentionQueryResult,
  type ProjectRetentionSetInput,
  type RequestKey,
  type WorkflowRunListResult,
  type WorkflowRunMutationResult,
  type WorkflowRunQueryResult,
  type WorkflowRunStartResult,
  type WorkflowScheduleListResult,
  type WorkflowScheduleMutationResult,
  type WorkflowScheduleOccurrenceListResult,
  type WorkflowScheduleOccurrenceQueryResult,
  type WorkflowScheduleQueryResult,
} from "@kojo/control";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import {
  forgetProject,
  listProjectPage,
  listProjects,
  listWorkflowDefinitions,
  registerProject,
  replayForgetProject,
  showProject,
  showWorkflowDefinition,
} from "../../../workflow-authoring/projects/use-cases/manage-projects";
import { newDeletionPlanKey } from "../../deletion/models/deletion-plan";
import { deleteExecutionData } from "../../deletion/use-cases/delete-execution-data";
import { ProjectRuntime } from "../../projects/services/project-runtime";
import {
  assessProjectReadiness,
  repairProjectReadiness,
} from "../../readiness/use-cases/project-readiness";
import { DrizzleRetentionRepositoryLive } from "../../retention/repositories/drizzle-retention-repository";
import type { RetentionRepository } from "../../retention/repositories/retention-repository";
import {
  resetProjectRetention,
  setProjectRetention,
  showProjectRetention,
} from "../../retention/use-cases/manage-retention";
import { LocalExecutionArtifactStoreLive } from "../../runs/services/execution-artifact-store";
import {
  completeWorkflowDeferred,
  downloadExecutionArtifact,
  exportExecutionTrace,
  listWorkflowRuns,
  readExecutionTrace,
  readWorkflowRunsRevision,
  resumeWorkflowRun,
  revealWorkflowRun,
  showWorkflowRun,
  startWorkflowRun,
  stopWorkflowRun,
} from "../../runs/use-cases/manage-workflow-runs";
import {
  listWorkflowScheduleOccurrences,
  showWorkflowScheduleOccurrence,
} from "../../schedules/use-cases/deliver-workflow-schedule-occurrences";
import {
  disableWorkflowSchedule,
  enableWorkflowSchedule,
  listNextWorkflowSchedules,
  listWorkflowSchedules,
  showWorkflowSchedule,
} from "../../schedules/use-cases/manage-workflow-schedules";
import type { HostIdentity } from "../models/host-identity";
import { HOST_INFORMATION } from "../models/host-information";
import { followControlSubscription } from "../use-cases/follow-control-subscription";
import { getHostCapabilities, getHostInformation } from "../use-cases/get-host-information";
import {
  ControlSubscriptionDeliveryWindow,
  type ControlSubscriptionDeliveryWindowShape,
  makeControlSubscriptionDeliveryWindow,
} from "./control-subscription-delivery-window";
import {
  ControlSubscriptionReader,
  type ControlSubscriptionReaderShape,
} from "./control-subscription-reader";
import { HostDiagnosticLogger, type HostRequestDiagnosticEvent } from "./host-diagnostic-logger";
import { prepareHostStoreDirectory } from "./host-store";

export { UnsafeHostStoreError } from "./host-store";

export interface KojoHostServer {
  readonly diagnosticPath: string;
  readonly lockPath: string;
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

export interface KojoHostOptions {
  readonly diagnosticPath: string;
  readonly lockPath?: string;
  readonly serverLayer: Layer.Layer<never, unknown, ControlSubscriptionDeliveryWindow>;
  readonly socketPath: string;
}

export class KojoHostAlreadyRunningError extends Error {
  override readonly name = "KojoHostAlreadyRunningError";
}

const withHostRequestDiagnostic = <A, E, R>(
  hostIdentity: HostIdentity,
  operation: HostRequestDiagnosticEvent["operation"],
  requestId: string,
  effect: Effect.Effect<A, E, R>,
  classify?: (value: A) => {
    readonly projectIdentity?: ProjectIdentity;
    readonly safeErrorCode?: HostRequestDiagnosticEvent["safeErrorCode"];
  },
) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const exit = yield* Effect.exit(effect);
    const logger = yield* HostDiagnosticLogger;
    const classification = Exit.isSuccess(exit) ? classify?.(exit.value) : undefined;
    yield* logger
      .emit({
        eventVersion: 1,
        eventKind: "host-request.completed",
        hostIdentity,
        requestId,
        operation,
        outcome:
          Exit.isFailure(exit) || classification?.safeErrorCode !== undefined ? "error" : "success",
        durationMs: Math.max(0, Date.now() - startedAt),
        hostVersion: HOST_INFORMATION.hostVersion,
        protocolMajor: HOST_INFORMATION.protocol.major,
        protocolMinor: HOST_INFORMATION.protocol.minor,
        ...(classification?.projectIdentity === undefined
          ? {}
          : { projectIdentity: classification.projectIdentity }),
        ...(classification?.safeErrorCode === undefined
          ? {}
          : { safeErrorCode: classification.safeErrorCode }),
        timestamp: new Date().toISOString(),
      })
      .pipe(Effect.ignore);
    return yield* exit;
  });

const mutationDiagnostic = (result: ProjectMutationResult) => {
  if (result.ok) return { projectIdentity: result.project.identity };
  const affected = result.error.affectedResource;
  return {
    ...(affected.kind === "project" ? { projectIdentity: affected.identity } : {}),
    safeErrorCode: result.error.code,
  };
};

const queryDiagnostic =
  (identity: ProjectIdentity) =>
  (result: {
    readonly ok: boolean;
    readonly error?: { readonly code: ProjectOperationErrorCode };
  }) => ({
    projectIdentity: identity,
    ...(result.ok || result.error === undefined ? {} : { safeErrorCode: result.error.code }),
  });

const readinessDiagnostic =
  (identity: ProjectIdentity) =>
  (result: ProjectReadinessQueryResult | ProjectReadinessRepairResult) => ({
    projectIdentity: identity,
    ...(result.ok ? {} : { safeErrorCode: result.error.code }),
  });

const retentionDiagnostic =
  (identity: ProjectIdentity) =>
  (result: ProjectRetentionQueryResult | ProjectRetentionMutationResult) => ({
    projectIdentity: identity,
    ...(result.ok ? {} : { safeErrorCode: result.error.code }),
  });

const deletionDiagnostic = (identity: ProjectIdentity) => (result: DeletionResult) => ({
  projectIdentity: identity,
  ...(result.ok ? {} : { safeErrorCode: result.error.code }),
});

const deletionRequestDiagnostic = (scope: DeletionScope) => (result: DeletionResult) =>
  scope.kind === "project" && result.ok && result.kind === "completed"
    ? {}
    : deletionDiagnostic(scope.identity)(result);

const blockedDeletionRequest = (
  scope: DeletionScope,
  planKey: RequestKey | undefined,
): DeletionResult => ({
  ok: false,
  requestKey: planKey ?? newDeletionPlanKey(),
  error: {
    code: "deletion-in-progress",
    message: "Another deletion is already making this Project unavailable.",
    next:
      planKey === undefined
        ? "Retry this deletion preview after the original pending confirmed deletion completes."
        : "Retry the original pending confirmed Plan Key after the Host resumes the pending deletion; do not retry this superseding Plan Key.",
    affectedResource:
      scope.kind === "run"
        ? { kind: "run", identity: scope.identity, runId: scope.runId }
        : scope.kind === "schedule"
          ? { kind: "schedule", identity: scope.identity, scheduleKey: scope.scheduleKey }
          : scope.kind === "occurrences"
            ? { kind: "occurrences", identity: scope.identity }
            : { kind: "project", identity: scope.identity },
    findingKeys: [],
  },
});

const workflowRunDiagnostic =
  (identity: ProjectIdentity) =>
  (
    result:
      | WorkflowRunStartResult
      | WorkflowRunListResult
      | WorkflowRunMutationResult
      | WorkflowRunQueryResult
      | ExecutionTraceQueryResult
      | ExecutionTraceExportResult
      | ExecutionArtifactDownloadResult,
  ) => ({
    projectIdentity: identity,
    ...(result.ok ? {} : { safeErrorCode: result.error.code }),
  });

const workflowScheduleDiagnostic =
  (identity: ProjectIdentity) =>
  (
    result:
      | WorkflowScheduleListResult
      | WorkflowScheduleMutationResult
      | WorkflowScheduleOccurrenceListResult
      | WorkflowScheduleOccurrenceQueryResult
      | WorkflowScheduleQueryResult,
  ) => ({
    projectIdentity: identity,
    ...(result.ok ? {} : { safeErrorCode: result.error.code }),
  });

const controlResourceFingerprint = (
  identity: ProjectIdentity,
  topic: "readiness" | "schedules" | "runs",
) => {
  switch (topic) {
    case "readiness":
      return Effect.map(assessProjectReadiness(identity), JSON.stringify);
    case "schedules":
      return Effect.map(
        listWorkflowSchedules({ conditions: [], identity, workflowKeys: [] }),
        JSON.stringify,
      );
    case "runs":
      return readWorkflowRunsRevision(identity);
  }
};

/** Transport-neutral subscription policy lives in the workflow-execution use case. */
export const makeControlSubscription = (
  reader: ControlSubscriptionReaderShape<unknown>,
  deliveryWindow: ControlSubscriptionDeliveryWindowShape,
) => followControlSubscription<unknown>(reader, deliveryWindow);

const ControlSubscriptionReaderLive = Layer.succeed(ControlSubscriptionReader, {
  readResourceFingerprint: controlResourceFingerprint,
  readTrace: readExecutionTrace,
});

const makeKojoControlHandlers = (hostIdentity: HostIdentity) =>
  KojoControl.toLayer(
    KojoControl.of({
      Negotiate: (_payload, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "Negotiate",
          String(options.requestId),
          getHostInformation,
        ),
      NegotiateCapabilities: (_payload, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "NegotiateCapabilities",
          String(options.requestId),
          getHostCapabilities,
        ),
      ListProjects: (_payload, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ListProjects",
          String(options.requestId),
          listProjects,
        ),
      ListProjectPage: (payload, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ListProjectPage",
          String(options.requestId),
          listProjectPage(payload),
        ),
      ShowProject: ({ identity }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ShowProject",
          String(options.requestId),
          showProject(identity),
          queryDiagnostic(identity),
        ),
      ShowProjectRetention: ({ identity }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ShowProjectRetention",
          String(options.requestId),
          showProjectRetention(identity),
          retentionDiagnostic(identity),
        ),
      SetProjectRetention: (input: ProjectRetentionSetInput, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "SetProjectRetention",
          String(options.requestId),
          setProjectRetention(input),
          retentionDiagnostic(input.identity),
        ),
      ResetProjectRetention: ({ identity, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ResetProjectRetention",
          String(options.requestId),
          resetProjectRetention(identity, requestKey),
          retentionDiagnostic(identity),
        ),
      DeleteExecutionData: ({ scope, planKey }, options) =>
        Effect.gen(function* () {
          const request = withHostRequestDiagnostic(
            hostIdentity,
            "DeleteExecutionData",
            String(options.requestId),
            deleteExecutionData(scope, planKey, {
              diagnosticLockHeld: planKey !== undefined,
            }),
            deletionRequestDiagnostic(scope),
          );
          const runtime = yield* ProjectRuntime;
          if (runtime.coordinateProjectDiagnosticRequest === undefined) return yield* request;
          return yield* runtime.coordinateProjectDiagnosticRequest(
            scope.identity,
            request,
            Effect.succeed(blockedDeletionRequest(scope, planKey)),
            { reserveDeletionFence: planKey !== undefined },
          );
        }),
      ShowProjectReadiness: ({ identity }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ShowProjectReadiness",
          String(options.requestId),
          assessProjectReadiness(identity),
          readinessDiagnostic(identity),
        ),
      RefreshProjectReadiness: ({ identity }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "RefreshProjectReadiness",
          String(options.requestId),
          assessProjectReadiness(identity),
          readinessDiagnostic(identity),
        ),
      RepairProjectReadiness: ({ identity, assessmentRevision, action, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "RepairProjectReadiness",
          String(options.requestId),
          repairProjectReadiness({ identity, assessmentRevision, action, requestKey }),
          readinessDiagnostic(identity),
        ),
      ListWorkflowDefinitions: ({ identity }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ListWorkflowDefinitions",
          String(options.requestId),
          listWorkflowDefinitions(identity),
          queryDiagnostic(identity),
        ),
      ShowWorkflowDefinition: ({ identity, workflowKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ShowWorkflowDefinition",
          String(options.requestId),
          showWorkflowDefinition(identity, workflowKey),
          queryDiagnostic(identity),
        ),
      ListWorkflowSchedules: (input, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ListWorkflowSchedules",
          String(options.requestId),
          listWorkflowSchedules(input),
          workflowScheduleDiagnostic(input.identity),
        ),
      ShowWorkflowSchedule: ({ identity, scheduleKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ShowWorkflowSchedule",
          String(options.requestId),
          showWorkflowSchedule(identity, scheduleKey),
          workflowScheduleDiagnostic(identity),
        ),
      ListNextWorkflowSchedules: (input, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ListNextWorkflowSchedules",
          String(options.requestId),
          listNextWorkflowSchedules(input),
          workflowScheduleDiagnostic(input.identity),
        ),
      EnableWorkflowSchedule: ({ identity, scheduleKey, scheduleRevision, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "EnableWorkflowSchedule",
          String(options.requestId),
          enableWorkflowSchedule({ identity, scheduleKey, scheduleRevision, requestKey }),
          workflowScheduleDiagnostic(identity),
        ),
      DisableWorkflowSchedule: ({ identity, scheduleKey, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "DisableWorkflowSchedule",
          String(options.requestId),
          disableWorkflowSchedule({ identity, scheduleKey, requestKey }),
          workflowScheduleDiagnostic(identity),
        ),
      ListWorkflowScheduleOccurrences: (input, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ListWorkflowScheduleOccurrences",
          String(options.requestId),
          listWorkflowScheduleOccurrences(input),
          workflowScheduleDiagnostic(input.identity),
        ),
      ShowWorkflowScheduleOccurrence: ({ identity, scheduleKey, scheduledAtMs }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ShowWorkflowScheduleOccurrence",
          String(options.requestId),
          showWorkflowScheduleOccurrence(identity, scheduleKey, scheduledAtMs),
          workflowScheduleDiagnostic(identity),
        ),
      StartWorkflowRun: ({ identity, workflowKey, workflowRevision, input, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "StartWorkflowRun",
          String(options.requestId),
          startWorkflowRun({ identity, workflowKey, workflowRevision, input, requestKey }),
          workflowRunDiagnostic(identity),
        ),
      ListWorkflowRuns: (input, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ListWorkflowRuns",
          String(options.requestId),
          listWorkflowRuns(input),
          workflowRunDiagnostic(input.identity),
        ),
      ShowWorkflowRun: ({ identity, runId }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ShowWorkflowRun",
          String(options.requestId),
          showWorkflowRun(identity, runId),
          workflowRunDiagnostic(identity),
        ),
      RevealWorkflowRun: ({ identity, runId }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "RevealWorkflowRun",
          String(options.requestId),
          revealWorkflowRun(identity, runId),
          workflowRunDiagnostic(identity),
        ),
      ReadExecutionTrace: (input, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ReadExecutionTrace",
          String(options.requestId),
          readExecutionTrace(input),
          workflowRunDiagnostic(input.identity),
        ),
      ExportExecutionTrace: (input, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ExportExecutionTrace",
          String(options.requestId),
          exportExecutionTrace(input),
          workflowRunDiagnostic(input.identity),
        ),
      DownloadExecutionArtifact: (input, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "DownloadExecutionArtifact",
          String(options.requestId),
          downloadExecutionArtifact(input),
          workflowRunDiagnostic(input.identity),
        ),
      SubscribeControl: (input, options) =>
        Stream.unwrap(
          withHostRequestDiagnostic(
            hostIdentity,
            "SubscribeControl",
            String(options.requestId),
            Effect.all([ControlSubscriptionReader, ControlSubscriptionDeliveryWindow]).pipe(
              Effect.map(([reader, deliveryWindow]) =>
                makeControlSubscription(reader, deliveryWindow)(input),
              ),
            ),
          ),
        ),
      AcknowledgeControlSubscription: (delivery, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "AcknowledgeControlSubscription",
          String(options.requestId),
          Effect.flatMap(ControlSubscriptionDeliveryWindow, (window) =>
            window.acknowledge(delivery),
          ),
        ),
      ResumeWorkflowRun: ({ identity, runId, value, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ResumeWorkflowRun",
          String(options.requestId),
          resumeWorkflowRun({ identity, runId, value, requestKey }),
          workflowRunDiagnostic(identity),
        ),
      CompleteWorkflowDeferred: ({ identity, runId, token, value, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "CompleteWorkflowDeferred",
          String(options.requestId),
          completeWorkflowDeferred({ identity, runId, token, value, requestKey }),
          workflowRunDiagnostic(identity),
        ),
      StopWorkflowRun: ({ identity, runId, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "StopWorkflowRun",
          String(options.requestId),
          stopWorkflowRun({ identity, runId, requestKey }),
          workflowRunDiagnostic(identity),
        ),
      RegisterProject: ({ path, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "RegisterProject",
          String(options.requestId),
          registerProject(path, requestKey),
          mutationDiagnostic,
        ),
      ForgetProject: ({ identity, selector, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ForgetProject",
          String(options.requestId),
          forgetProject(identity, selector, requestKey),
          mutationDiagnostic,
        ),
      ReplayForgetProject: ({ selector, requestKey }, options) =>
        withHostRequestDiagnostic(
          hostIdentity,
          "ReplayForgetProject",
          String(options.requestId),
          replayForgetProject(selector, requestKey),
          mutationDiagnostic,
        ),
    }),
  );

const removeStaleSocket = async (socketPath: string) => {
  try {
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const isProcessRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const socketAcceptsConnections = (socketPath: string) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (active: boolean) => {
      socket.destroy();
      resolve(active);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

const acquireHostLock = async (lockPath: string) => {
  const token = randomUUID();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      await chmod(lockPath, 0o600);
      return async () => {
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8"));
          if (owner.token === token) await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (typeof owner.pid === "number" && isProcessRunning(owner.pid)) {
          throw new KojoHostAlreadyRunningError("Kojo Host is already running or starting.");
        }
        await unlink(lockPath);
      } catch (lockError) {
        if (lockError instanceof KojoHostAlreadyRunningError) throw lockError;
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new KojoHostAlreadyRunningError("Kojo Host ownership cannot be established.");
        }
      }
    }
  }
};

export const makeKojoControlServerLayer = <ProtocolError, ProtocolRequirements>(
  protocol: Layer.Layer<RpcServer.Protocol, ProtocolError, ProtocolRequirements>,
  diagnosticLogger: Layer.Layer<HostDiagnosticLogger>,
  hostIdentity: HostIdentity,
  subscriptionReader: Layer.Layer<ControlSubscriptionReader> = ControlSubscriptionReaderLive,
  retentionRepository: Layer.Layer<RetentionRepository> = DrizzleRetentionRepositoryLive(),
) =>
  RpcServer.layer(KojoControl).pipe(
    Layer.provide([
      makeKojoControlHandlers(hostIdentity).pipe(
        Layer.provide([
          diagnosticLogger,
          subscriptionReader,
          LocalExecutionArtifactStoreLive,
          retentionRepository,
        ]),
      ),
      protocol,
    ]),
  );

export const startKojoHost = async (options: KojoHostOptions): Promise<KojoHostServer> => {
  const socketDirectory = dirname(options.socketPath);
  const lockPath = options.lockPath ?? `${options.socketPath}.lock`;
  await prepareHostStoreDirectory(socketDirectory);
  if (dirname(lockPath) !== socketDirectory) await prepareHostStoreDirectory(dirname(lockPath));
  const releaseLock = await acquireHostLock(lockPath);
  let scope: Scope.Closeable | undefined;
  const deliveryWindow = makeControlSubscriptionDeliveryWindow();
  let mayOwnSocket = false;
  try {
    if (await socketAcceptsConnections(options.socketPath)) {
      throw new KojoHostAlreadyRunningError("Kojo Host is already running.");
    }
    await removeStaleSocket(options.socketPath);
    mayOwnSocket = true;
    scope = Effect.runSync(Scope.make());
    const previousUmask = process.umask(0o077);
    try {
      await Effect.runPromise(
        Layer.buildWithScope(
          options.serverLayer.pipe(
            Layer.provide(Layer.succeed(ControlSubscriptionDeliveryWindow, deliveryWindow)),
          ),
          scope,
        ),
      );
    } finally {
      process.umask(previousUmask);
    }
    await chmod(options.socketPath, 0o600);
    const serverScope = scope;

    return {
      diagnosticPath: options.diagnosticPath,
      lockPath,
      socketPath: options.socketPath,
      stop: async () => {
        try {
          await Effect.runPromise(deliveryWindow.shutdown);
          await Effect.runPromise(Scope.close(serverScope, Exit.void));
        } finally {
          try {
            await removeStaleSocket(options.socketPath);
          } finally {
            await releaseLock();
          }
        }
      },
    };
  } catch (error) {
    if (scope !== undefined) {
      await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
    }
    if (mayOwnSocket) await removeStaleSocket(options.socketPath);
    await releaseLock();
    throw error;
  }
};
