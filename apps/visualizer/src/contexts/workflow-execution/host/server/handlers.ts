import { VisualizerApi } from "../../../shared/models/contracts";
import { getHostOverview } from "../use-cases/get-host-overview";

export const HostOverviewHandler = VisualizerApi.toLayerHandler(
  "HostOverview",
  () => getHostOverview,
);
