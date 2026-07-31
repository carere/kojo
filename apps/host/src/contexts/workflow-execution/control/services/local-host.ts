import { randomUUID } from "node:crypto";
import { chmod, open, readFile, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import {
  type ControlSubscriptionInput,
  type ControlSubscriptionUpdate,
  type ExecutionTraceQueryResult,
  type ExecutionTraceReadInput,
  KojoControl,
  type ProjectIdentity,
  type ProjectMutationResult,
  type ProjectOperationErrorCode,
  type ProjectReadinessQueryResult,
  type ProjectReadinessRepairResult,
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
import { Effect, Exit, Layer, Schedule, Scope, Stream } from "effect";
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
import {
  assessProjectReadiness,
  repairProjectReadiness,
} from "../../readiness/use-cases/project-readiness";
import {
  completeWorkflowDeferred,
  listWorkflowRuns,
  readExecutionTrace,
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
import { getHostCapabilities, getHostInformation } from "../use-cases/get-host-information";
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
  readonly serverLayer: Layer.Layer<never, unknown>;
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

const workflowRunDiagnostic =
  (identity: ProjectIdentity) =>
  (
    result:
      | WorkflowRunStartResult
      | WorkflowRunListResult
      | WorkflowRunMutationResult
      | WorkflowRunQueryResult
      | ExecutionTraceQueryResult,
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

/**
 * This is intentionally an advisory stream. Every poll reads committed Events
 * by durable sequence, so a blocked or disconnected client cannot delay the
 * Project Runtime that appends them. A burst larger than the bounded delivery
 * page produces one explicit resync request instead of unbounded buffering.
 */
export const makeControlSubscription =
  <R>(
    readTrace: (
      input: ExecutionTraceReadInput,
    ) => Effect.Effect<ExecutionTraceQueryResult, never, R>,
  ) =>
  (input: ControlSubscriptionInput) => {
    const selectedProjects = new Set(input.projects);
    const sequences = new Map<string, number>();
    const traces = input.topics.includes("traces")
      ? input.traces.filter((trace) => selectedProjects.has(trace.identity))
      : [];
    for (const trace of traces)
      sequences.set(`${trace.identity}:${trace.runId}`, trace.afterSequence);
    const poll = Effect.gen(function* () {
      const updates: Array<ControlSubscriptionUpdate> = [];
      for (const trace of traces) {
        const key = `${trace.identity}:${trace.runId}`;
        const afterSequence = sequences.get(key) ?? trace.afterSequence;
        const result = yield* readTrace({
          identity: trace.identity,
          runId: trace.runId,
          afterSequence,
          filters: {
            activityAttemptIds: [],
            childRunIds: [],
            engineOperationIds: [],
            kinds: [],
          },
          limit: 100,
        });
        if (!result.ok) continue;
        if (result.page.nextCursor !== null) {
          sequences.set(key, result.page.highWaterSequence);
          updates.push({
            kind: "resync-required",
            identity: trace.identity,
            runId: trace.runId,
            highWaterSequence: result.page.highWaterSequence,
          });
          continue;
        }
        for (const event of result.page.events) {
          sequences.set(key, event.sequence);
          updates.push({
            kind: "trace-event",
            identity: trace.identity,
            runId: trace.runId,
            sequence: event.sequence,
            event,
          });
        }
      }
      return updates;
    });
    return Stream.fromEffect(poll).pipe(
      Stream.repeat(Schedule.spaced("100 millis")),
      Stream.flatMap((updates) => Stream.fromIterable(updates)),
    );
  };

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
      SubscribeControl: (input) => makeControlSubscription(readExecutionTrace)(input),
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
) =>
  RpcServer.layer(KojoControl).pipe(
    Layer.provide([
      makeKojoControlHandlers(hostIdentity).pipe(Layer.provide(diagnosticLogger)),
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
      await Effect.runPromise(Layer.buildWithScope(options.serverLayer, scope));
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
