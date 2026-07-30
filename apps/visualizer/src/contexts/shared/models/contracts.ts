import {
  HostOverview as HostOverviewSchema,
  ProjectIdentity,
  RequestKey,
  WorkflowRunId,
  WorkflowRunMutationResult,
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

export const VisualizerApi = RpcGroup.make(
  Health,
  HostOverview,
  ResumeWorkflowRun,
  CompleteWorkflowDeferred,
);
