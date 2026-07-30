import {
  HostOverview as HostOverviewSchema,
  ProjectIdentity,
  RequestKey,
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

export const VisualizerApi = RpcGroup.make(
  Health,
  HostOverview,
  EnableWorkflowSchedule,
  DisableWorkflowSchedule,
);
