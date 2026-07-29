import { Effect } from "effect";
import { HostOverviewError } from "../../../shared/models/contracts";
import { HostControlClient } from "../services/host-control-client";

export const getHostOverview = Effect.flatMap(
  HostControlClient,
  (client) => client.getHostOverview,
).pipe(
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
);
