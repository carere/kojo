import { CONTROL_CAPABILITIES, type HostInformation, PROTOCOL_VERSION } from "@kojo/control";

export const HOST_INFORMATION = {
  protocol: PROTOCOL_VERSION,
  hostVersion: "0.1.0",
  capabilities: CONTROL_CAPABILITIES,
} as const satisfies HostInformation;
