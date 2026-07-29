import { type HostInformation, PROTOCOL_VERSION } from "@kojo/control";
import { Effect } from "effect";

export const getHostInformation: Effect.Effect<HostInformation> = Effect.succeed({
  protocol: PROTOCOL_VERSION,
  hostVersion: "0.1.0",
  capabilities: ["projects:list"],
});
