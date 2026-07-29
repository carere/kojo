import { VisualizerApi } from "../../shared/models/contracts";
import { getHealth } from "./use-cases/get-health";

export const HealthHandler = VisualizerApi.toLayerHandler("Health", () => getHealth);
