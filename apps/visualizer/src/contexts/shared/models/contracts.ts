import {
  ControlSubscriptionAcknowledgement,
  ControlSubscriptionDelivery,
  ControlSubscriptionInput,
  ControlSubscriptionUpdate,
  ExecutionTraceQueryResult,
  ExecutionTraceReadInput,
  HostOverview as HostOverviewSchema,
  ProjectIdentity,
  ProjectReadinessActionKey,
  ProjectReadinessQueryResult,
  ProjectReadinessRepairResult,
  RequestKey,
  WorkflowRunId,
  WorkflowRunMutationResult,
  WorkflowRunQueryResult,
  WorkflowRunStartResult,
  WorkflowScheduleMutationResult,
} from "@kojo/control";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const Health = Rpc.make("Health", {
  success: Schema.Struct({
    service: Schema.Literal("visualizer"),
    status: Schema.Literal("ok"),
  }),
});

export class HostOverviewError extends Schema.TaggedErrorClass<HostOverviewError>()(
  "HostOverviewError",
  {
    code: Schema.Literals(["host-unavailable", "incompatible-protocol"]),
    message: Schema.String,
    next: Schema.String,
  },
) {}

export const HostOverview = Rpc.make("HostOverview", {
  success: HostOverviewSchema,
  error: HostOverviewError,
});

export const RefreshProjectReadiness = Rpc.make("RefreshProjectReadiness", {
  payload: { identity: ProjectIdentity },
  success: ProjectReadinessQueryResult,
  error: HostOverviewError,
});

export const RepairProjectReadiness = Rpc.make("RepairProjectReadiness", {
  payload: {
    identity: ProjectIdentity,
    assessmentRevision: Schema.String,
    action: ProjectReadinessActionKey,
    requestKey: RequestKey,
  },
  success: ProjectReadinessRepairResult,
  error: HostOverviewError,
});

export const EnableWorkflowSchedule = Rpc.make("EnableWorkflowSchedule", {
  payload: {
    identity: ProjectIdentity,
    scheduleKey: Schema.String,
    scheduleRevision: Schema.String,
    requestKey: RequestKey,
  },
  success: WorkflowScheduleMutationResult,
  error: HostOverviewError,
});

export const DisableWorkflowSchedule = Rpc.make("DisableWorkflowSchedule", {
  payload: { identity: ProjectIdentity, scheduleKey: Schema.String, requestKey: RequestKey },
  success: WorkflowScheduleMutationResult,
  error: HostOverviewError,
});

export const ResumeWorkflowRun = Rpc.make("ResumeWorkflowRun", {
  payload: {
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    value: Schema.optionalKey(Schema.Unknown),
    requestKey: RequestKey,
  },
  success: WorkflowRunMutationResult,
  error: HostOverviewError,
});

export const CompleteWorkflowDeferred = Rpc.make("CompleteWorkflowDeferred", {
  payload: {
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    token: Schema.String,
    value: Schema.optionalKey(Schema.Unknown),
    requestKey: RequestKey,
  },
  success: WorkflowRunMutationResult,
  error: HostOverviewError,
});

export const StopWorkflowRun = Rpc.make("StopWorkflowRun", {
  payload: { identity: ProjectIdentity, runId: WorkflowRunId, requestKey: RequestKey },
  success: WorkflowRunMutationResult,
  error: HostOverviewError,
});

export const StartWorkflowRun = Rpc.make("StartWorkflowRun", {
  payload: {
    identity: ProjectIdentity,
    workflowKey: Schema.String,
    workflowRevision: Schema.String,
    input: Schema.Unknown,
    requestKey: RequestKey,
  },
  success: WorkflowRunStartResult,
  error: HostOverviewError,
});

export const RevealWorkflowRun = Rpc.make("RevealWorkflowRun", {
  payload: { identity: ProjectIdentity, runId: WorkflowRunId },
  success: WorkflowRunQueryResult,
  error: HostOverviewError,
});

/** Same-origin proxy for the Host-owned chronological Execution Trace. */
export const ReadExecutionTrace = Rpc.make("ReadExecutionTrace", {
  payload: ExecutionTraceReadInput.fields,
  success: ExecutionTraceQueryResult,
  error: HostOverviewError,
});

/** Same-origin stream; browsers never receive the Host socket directly. */
export const SubscribeControl = Rpc.make("SubscribeControl", {
  payload: ControlSubscriptionInput.fields,
  success: ControlSubscriptionUpdate,
  error: HostOverviewError,
  stream: true,
});

/** Browser acknowledgement remains same-origin; it never exposes the Host socket. */
export const AcknowledgeControlSubscription = Rpc.make("AcknowledgeControlSubscription", {
  payload: ControlSubscriptionDelivery.fields,
  success: ControlSubscriptionAcknowledgement,
  error: HostOverviewError,
});

export const VisualizerApi = RpcGroup.make(
  Health,
  HostOverview,
  RefreshProjectReadiness,
  RepairProjectReadiness,
  EnableWorkflowSchedule,
  DisableWorkflowSchedule,
  ResumeWorkflowRun,
  CompleteWorkflowDeferred,
  StopWorkflowRun,
  StartWorkflowRun,
  RevealWorkflowRun,
  ReadExecutionTrace,
  SubscribeControl,
  AcknowledgeControlSubscription,
);
