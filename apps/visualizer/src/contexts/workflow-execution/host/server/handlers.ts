import { VisualizerApi } from "../../../shared/models/contracts";
import {
  disableWorkflowSchedule,
  enableWorkflowSchedule,
} from "../use-cases/control-workflow-schedule";
import {
  completeWorkflowDeferred,
  getHostOverview,
  readExecutionTrace,
  refreshProjectReadiness,
  repairProjectReadiness,
  resumeWorkflowRun,
  stopWorkflowRun,
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

export const ReadExecutionTraceHandler = VisualizerApi.toLayerHandler(
  "ReadExecutionTrace",
  (input) => readExecutionTrace(input),
);
