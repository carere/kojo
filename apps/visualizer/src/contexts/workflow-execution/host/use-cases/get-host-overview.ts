import type {
  ControlSubscriptionAcknowledgement,
  ControlSubscriptionDelivery,
  ControlSubscriptionInput,
  ControlSubscriptionUpdate,
  ExecutionArtifactDownloadInput,
  ExecutionArtifactDownloadResult,
  ExecutionTraceQueryResult,
  ExecutionTraceReadInput,
  ProjectIdentity,
  ProjectReadinessActionKey,
  RequestKey,
  WorkflowRunId,
  WorkflowRunQueryResult,
  WorkflowRunStartResult,
} from "@kojo/control";
import { Effect, Stream } from "effect";
import { HostOverviewError } from "../../../shared/models/contracts";
import { HostControlClient } from "../services/host-control-client";

export const getHostOverview = Effect.flatMap(
  HostControlClient,
  (client) => client.getHostOverview,
).pipe(
  Effect.mapError((error) =>
    error._tag === "IncompatibleProtocolError"
      ? new HostOverviewError({
          code: "incompatible-protocol",
          message: error.message,
          next: "Upgrade Kojo Host or the visualizer so their protocol major versions match.",
        })
      : new HostOverviewError({
          code: "host-unavailable",
          message: error.message,
          next: "Start the Kojo Host and try again.",
        }),
  ),
);

export const readExecutionTrace = (input: ExecutionTraceReadInput) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.readExecutionTrace === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot read Execution Traces.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : (client.readExecutionTrace(input).pipe(Effect.mapError(hostError)) as Effect.Effect<
          ExecutionTraceQueryResult,
          HostOverviewError
        >),
  );

/** Server-only use case for an attachment response; browsers never see Host socket bytes directly. */
export const downloadExecutionArtifact = (input: ExecutionArtifactDownloadInput) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.downloadExecutionArtifact === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot download Execution Artifacts.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : (client.downloadExecutionArtifact(input).pipe(Effect.mapError(hostError)) as Effect.Effect<
          ExecutionArtifactDownloadResult,
          HostOverviewError
        >),
  );

export const subscribeControl = (input: ControlSubscriptionInput) =>
  Stream.unwrap(
    Effect.map(HostControlClient, (client) =>
      client.subscribeControl(input).pipe(Stream.mapError(hostError)),
    ),
  ) as Stream.Stream<ControlSubscriptionUpdate, HostOverviewError>;

export const acknowledgeControlSubscription = (delivery: ControlSubscriptionDelivery) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.acknowledgeControlSubscription(delivery).pipe(Effect.mapError(hostError)),
  ) as Effect.Effect<ControlSubscriptionAcknowledgement, HostOverviewError>;

const hostError = (error: { readonly _tag: string; readonly message: string }) =>
  error._tag === "IncompatibleProtocolError"
    ? new HostOverviewError({
        code: "incompatible-protocol",
        message: error.message,
        next: "Upgrade Kojo Host or the visualizer so their protocol major versions match.",
      })
    : new HostOverviewError({
        code: "host-unavailable",
        message: error.message,
        next: "Start the Kojo Host and try again.",
      });

export const resumeWorkflowRun = (
  identity: ProjectIdentity,
  runId: WorkflowRunId,
  value: unknown,
  requestKey: RequestKey,
) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.resumeWorkflowRun === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot resume Workflow Runs.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : client
          .resumeWorkflowRun(identity, runId, value, requestKey)
          .pipe(Effect.mapError(hostError)),
  );

export const completeWorkflowDeferred = (
  identity: ProjectIdentity,
  runId: WorkflowRunId,
  token: string,
  value: unknown,
  requestKey: RequestKey,
) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.completeWorkflowDeferred === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot complete Workflow Deferreds.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : client
          .completeWorkflowDeferred(identity, runId, token, value, requestKey)
          .pipe(Effect.mapError(hostError)),
  );

export const stopWorkflowRun = (
  identity: ProjectIdentity,
  runId: WorkflowRunId,
  requestKey: RequestKey,
) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.stopWorkflowRun === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot stop Workflow Runs.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : client.stopWorkflowRun(identity, runId, requestKey).pipe(Effect.mapError(hostError)),
  );

export const startWorkflowRun = (
  identity: ProjectIdentity,
  workflowKey: string,
  workflowRevision: string,
  input: unknown,
  requestKey: RequestKey,
) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.startWorkflowRun === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot start Workflow Runs.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : (client
          .startWorkflowRun(identity, workflowKey, workflowRevision, input, requestKey)
          .pipe(Effect.mapError(hostError)) as Effect.Effect<
          WorkflowRunStartResult,
          HostOverviewError
        >),
  );

export const revealWorkflowRun = (identity: ProjectIdentity, runId: WorkflowRunId) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.revealWorkflowRun === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot reveal Workflow Run data.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : (client
          .revealWorkflowRun(identity, runId)
          .pipe(Effect.mapError(hostError)) as Effect.Effect<
          WorkflowRunQueryResult,
          HostOverviewError
        >),
  );

export const refreshProjectReadiness = (identity: ProjectIdentity) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.refreshProjectReadiness === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot refresh Project Runtime Readiness.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : client.refreshProjectReadiness(identity).pipe(Effect.mapError(hostError)),
  );

export const repairProjectReadiness = (
  identity: ProjectIdentity,
  assessmentRevision: string,
  action: ProjectReadinessActionKey,
  requestKey: RequestKey,
) =>
  Effect.flatMap(HostControlClient, (client) =>
    client.repairProjectReadiness === undefined
      ? Effect.fail(
          new HostOverviewError({
            code: "host-unavailable",
            message: "The visualizer Host client cannot repair Project Runtime Readiness.",
            next: "Restart the visualizer and try again.",
          }),
        )
      : client
          .repairProjectReadiness(identity, assessmentRevision, action, requestKey)
          .pipe(Effect.mapError(hostError)),
  );
