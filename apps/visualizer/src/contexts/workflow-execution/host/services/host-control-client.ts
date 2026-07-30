import type {
  HostOverview,
  ProjectIdentity,
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
import { Context, Effect, Layer } from "effect";

export interface HostControlClientShape {
  readonly getHostOverview: Effect.Effect<
    HostOverview,
    LocalTransportError | IncompatibleProtocolError | UnsupportedControlCapabilityError
  >;
  readonly enableWorkflowSchedule: ReturnType<
    typeof makeDefaultLocalClient
  >["enableWorkflowSchedule"];
  readonly disableWorkflowSchedule: ReturnType<
    typeof makeDefaultLocalClient
  >["disableWorkflowSchedule"];
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
}

export class HostControlClient extends Context.Service<HostControlClient, HostControlClientShape>()(
  "kojo/visualizer/HostControlClient",
) {}

export const HostControlClientLive = Layer.succeed(HostControlClient, {
  getHostOverview: Effect.suspend(
    () =>
      makeDefaultLocalClient(process.env.KOJO_HOST_SOCKET ?? defaultSocketPath()).getHostOverview,
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
});
