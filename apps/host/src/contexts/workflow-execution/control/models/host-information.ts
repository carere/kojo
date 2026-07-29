import { CONTROL_CAPABILITIES, type HostInformation, PROTOCOL_VERSION } from "@kojo/control";

export const HOST_INFORMATION = {
  protocol: PROTOCOL_VERSION,
  hostVersion: "0.1.0",
  capabilities: CONTROL_CAPABILITIES,
} as const satisfies HostInformation;

export const LEGACY_HOST_INFORMATION = {
  ...HOST_INFORMATION,
  capabilities: ["projects:list"],
} as const satisfies HostInformation;
