import { Effect } from "effect";
import { getHealth } from "../../readiness/server/use-cases/get-health";
import { HostControlClient } from "../../workflow-execution/host/services/host-control-client";
import { VisualizerApi } from "../models/contracts";

export const VisualizerApiHandlers = VisualizerApi.toLayer(
  VisualizerApi.of({
    Health: () => getHealth,
    HostOverview: () => Effect.flatMap(HostControlClient, (client) => client.getHostOverview),
  }),
);
