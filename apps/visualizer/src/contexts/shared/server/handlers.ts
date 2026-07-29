import { Effect } from "effect";
import { getHealth } from "../../readiness/server/use-cases/get-health";
import { HostControlClient } from "../../workflow-execution/host/services/host-control-client";
import { HostOverviewError, VisualizerApi } from "../models/contracts";

export const VisualizerApiHandlers = VisualizerApi.toLayer(
  VisualizerApi.of({
    Health: () => getHealth,
    HostOverview: () =>
      Effect.flatMap(HostControlClient, (client) => client.getHostOverview).pipe(
        Effect.mapError((error) =>
          error._tag === "IncompatibleProtocolError"
            ? new HostOverviewError({
                code: "incompatible-protocol",
                message: error.message,
                next: "Upgrade Kojo Host or the visualizer so their protocol major versions match.",
              })
            : new HostOverviewError({
                code: "host-unavailable",
                message: error.message,
                next: "Start the Kojo Host and try again.",
              }),
        ),
      ),
  }),
);
