import { VisualizerApi } from "../../../shared/models/contracts";
import {
  disableWorkflowSchedule,
  enableWorkflowSchedule,
} from "../use-cases/control-workflow-schedule";
import {
  acknowledgeControlSubscription,
  completeWorkflowDeferred,
  getHostOverview,
  readExecutionTrace,
  refreshProjectReadiness,
  repairProjectReadiness,
  resumeWorkflowRun,
  revealWorkflowRun,
  startWorkflowRun,
  stopWorkflowRun,
  subscribeControl,
} from "../use-cases/get-host-overview";

export const HostOverviewHandler = VisualizerApi.toLayerHandler(
  "HostOverview",
  () => getHostOverview,
);

export const RefreshProjectReadinessHandler = VisualizerApi.toLayerHandler(
  "RefreshProjectReadiness",
  ({ identity }) => refreshProjectReadiness(identity),
);

export const RepairProjectReadinessHandler = VisualizerApi.toLayerHandler(
  "RepairProjectReadiness",
  ({ identity, assessmentRevision, action, requestKey }) =>
    repairProjectReadiness(identity, assessmentRevision, action, requestKey),
);

export const EnableWorkflowScheduleHandler = VisualizerApi.toLayerHandler(
  "EnableWorkflowSchedule",
  (payload) => enableWorkflowSchedule(payload),
);

export const DisableWorkflowScheduleHandler = VisualizerApi.toLayerHandler(
  "DisableWorkflowSchedule",
  (payload) => disableWorkflowSchedule(payload),
);

export const ResumeWorkflowRunHandler = VisualizerApi.toLayerHandler(
  "ResumeWorkflowRun",
  ({ identity, runId, value, requestKey }) => resumeWorkflowRun(identity, runId, value, requestKey),
);

export const CompleteWorkflowDeferredHandler = VisualizerApi.toLayerHandler(
  "CompleteWorkflowDeferred",
  ({ identity, runId, token, value, requestKey }) =>
    completeWorkflowDeferred(identity, runId, token, value, requestKey),
);

export const StopWorkflowRunHandler = VisualizerApi.toLayerHandler(
  "StopWorkflowRun",
  ({ identity, runId, requestKey }) => stopWorkflowRun(identity, runId, requestKey),
);

export const StartWorkflowRunHandler = VisualizerApi.toLayerHandler(
  "StartWorkflowRun",
  ({ identity, workflowKey, workflowRevision, input, requestKey }) =>
    startWorkflowRun(identity, workflowKey, workflowRevision, input, requestKey),
);

export const RevealWorkflowRunHandler = VisualizerApi.toLayerHandler(
  "RevealWorkflowRun",
  ({ identity, runId }) => revealWorkflowRun(identity, runId),
);

export const ReadExecutionTraceHandler = VisualizerApi.toLayerHandler(
  "ReadExecutionTrace",
  (input) => readExecutionTrace(input),
);

export const SubscribeControlHandler = VisualizerApi.toLayerHandler("SubscribeControl", (input) =>
  subscribeControl(input),
);

export const AcknowledgeControlSubscriptionHandler = VisualizerApi.toLayerHandler(
  "AcknowledgeControlSubscription",
  (delivery) => acknowledgeControlSubscription(delivery),
);
