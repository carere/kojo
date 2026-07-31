import type {
  ProjectIdentity,
  ProjectReadinessActionKey,
  RequestKey,
  WorkflowRunId,
} from "@kojo/control";
import { Effect } from "effect";
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
