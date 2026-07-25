import { getHealth } from "../../readiness/server/use-cases/get-health";
import { VisualizerApi } from "../models/contracts";

export const VisualizerApiHandlers = VisualizerApi.toLayer(
  VisualizerApi.of({
    Health: () => getHealth,
  }),
);
