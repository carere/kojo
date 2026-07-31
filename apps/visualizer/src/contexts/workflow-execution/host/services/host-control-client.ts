import type {
  ControlSubscriptionInput,
  ControlSubscriptionUpdate,
  ExecutionTraceQueryResult,
  ExecutionTraceReadInput,
  HostOverview,
  ProjectIdentity,
  ProjectReadinessActionKey,
  ProjectReadinessQueryResult,
  ProjectReadinessRepairResult,
  RequestKey,
  WorkflowRunId,
  WorkflowRunMutationResult,
} from "@kojo/control";
import {
  defaultSocketPath,
  type IncompatibleProtocolError,
  type LocalTransportError,
  makeDefaultLocalClient,
  type UnsupportedControlCapabilityError,
} from "@kojo/control/local-client";
import { Context, Effect, Layer, type Stream } from "effect";

export interface HostControlClientShape {
  readonly getHostOverview: Effect.Effect<
    HostOverview,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
  readonly readExecutionTrace?: (
    input: ExecutionTraceReadInput,
  ) => Effect.Effect<
    ExecutionTraceQueryResult,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
  readonly subscribeControl: (
    input: ControlSubscriptionInput,
  ) => Stream.Stream<
    ControlSubscriptionUpdate,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
  readonly acknowledgeControlSubscription: ReturnType<
    typeof makeDefaultLocalClient
  >["acknowledgeControlSubscription"];
  readonly enableWorkflowSchedule: ReturnType<
    typeof makeDefaultLocalClient
  >["enableWorkflowSchedule"];
  readonly disableWorkflowSchedule: ReturnType<
    typeof makeDefaultLocalClient
  >["disableWorkflowSchedule"];
  readonly refreshProjectReadiness?: (
    identity: ProjectIdentity,
  ) => Effect.Effect<
    ProjectReadinessQueryResult,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
  readonly repairProjectReadiness?: (
    identity: ProjectIdentity,
    assessmentRevision: string,
    action: ProjectReadinessActionKey,
    requestKey: RequestKey,
  ) => Effect.Effect<
    ProjectReadinessRepairResult,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
  readonly resumeWorkflowRun?: (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    value: unknown,
    requestKey: RequestKey,
  ) => Effect.Effect<
    WorkflowRunMutationResult,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
  readonly completeWorkflowDeferred?: (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    token: string,
    value: unknown,
    requestKey: RequestKey,
  ) => Effect.Effect<
    WorkflowRunMutationResult,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
  readonly stopWorkflowRun?: (
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    requestKey: RequestKey,
  ) => Effect.Effect<
    WorkflowRunMutationResult,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
}

export class HostControlClient extends Context.Service<HostControlClient, HostControlClientShape>()(
  "kojo/visualizer/HostControlClient",
) {}

export const HostControlClientLive = Layer.succeed(HostControlClient, {
  getHostOverview: Effect.suspend(() =>
    makeDefaultLocalClient(
      process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
    ).getHostOverview.pipe(
      Effect.map((overview) => ({
        ...overview,
        workflowRuns: overview.workflowRuns.map((snapshot) => ({
          ...snapshot,
          runs: snapshot.runs.map((run) => ({
            ...run,
            parentRunId: run.parentRunId ?? null,
            childInvocationKey: run.childInvocationKey ?? null,
          })),
        })),
      })),
    ),
  ),
  readExecutionTrace: (input) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(
        process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
      ).readExecutionTrace(input),
    ) as unknown as Effect.Effect<
      ExecutionTraceQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >,
  subscribeControl: (input) =>
    makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath()).subscribeControl(
      input,
    ) as Stream.Stream<
      ControlSubscriptionUpdate,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >,
  acknowledgeControlSubscription: (delivery) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(
        process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
      ).acknowledgeControlSubscription(delivery),
    ),
  enableWorkflowSchedule: (identity, scheduleKey, scheduleRevision, requestKey) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(
        process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
      ).enableWorkflowSchedule(identity, scheduleKey, scheduleRevision, requestKey),
    ),
  disableWorkflowSchedule: (identity, scheduleKey, requestKey) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(
        process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
      ).disableWorkflowSchedule(identity, scheduleKey, requestKey),
    ),
  refreshProjectReadiness: (identity) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(
        process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
      ).refreshProjectReadiness(identity),
    ) as unknown as Effect.Effect<
      ProjectReadinessQueryResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >,
  repairProjectReadiness: (identity, assessmentRevision, action, requestKey) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(
        process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
      ).repairProjectReadiness(identity, assessmentRevision, action, requestKey),
    ) as unknown as Effect.Effect<
      ProjectReadinessRepairResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >,
  resumeWorkflowRun: (identity, runId, value, requestKey) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath()).resumeWorkflowRun(
        identity,
        runId,
        value,
        requestKey,
      ),
    ) as unknown as Effect.Effect<
      WorkflowRunMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >,
  completeWorkflowDeferred: (identity, runId, token, value, requestKey) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(
        process.env.KOJO_HOST_SOCKET ?? defaultSocketPath(),
      ).completeWorkflowDeferred(identity, runId, token, value, requestKey),
    ) as unknown as Effect.Effect<
      WorkflowRunMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >,
  stopWorkflowRun: (identity, runId, requestKey) =>
    Effect.suspend(() =>
      makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath()).stopWorkflowRun(
        identity,
        runId,
        requestKey,
      ),
    ) as unknown as Effect.Effect<
      WorkflowRunMutationResult,
      LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
    >,
});
