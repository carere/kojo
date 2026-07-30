import { VisualizerApi } from "../../../shared/models/contracts";
import {
  completeWorkflowDeferred,
  getHostOverview,
  resumeWorkflowRun,
} from "../use-cases/get-host-overview";

export const HostOverviewHandler = VisualizerApi.toLayerHandler(
  "HostOverview",
  () => getHostOverview,
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
