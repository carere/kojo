import { VisualizerApi } from "../../../shared/models/contracts";
import {
  disableWorkflowSchedule,
  enableWorkflowSchedule,
} from "../use-cases/control-workflow-schedule";
import { getHostOverview } from "../use-cases/get-host-overview";

export const HostOverviewHandler = VisualizerApi.toLayerHandler(
  "HostOverview",
  () => getHostOverview,
);

export const EnableWorkflowScheduleHandler = VisualizerApi.toLayerHandler(
  "EnableWorkflowSchedule",
  (payload) => enableWorkflowSchedule(payload),
);

export const DisableWorkflowScheduleHandler = VisualizerApi.toLayerHandler(
  "DisableWorkflowSchedule",
  (payload) => disableWorkflowSchedule(payload),
);
