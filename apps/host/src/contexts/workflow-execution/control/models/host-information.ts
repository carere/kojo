import { type HostInformation, PROTOCOL_VERSION } from "@kojo/control";

export const HOST_INFORMATION = {
  protocol: PROTOCOL_VERSION,
  hostVersion: "0.1.0",
  capabilities: ["projects:list"],
} as const satisfies HostInformation;
