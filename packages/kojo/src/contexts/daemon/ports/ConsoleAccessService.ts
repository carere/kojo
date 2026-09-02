import type { DaemonEndpoint } from "../models/Endpoint.ts";

export interface ConsoleGrant {
  readonly expiresAt: string;
  readonly launchUrl: string;
}

/** Supplies current Daemon discovery and one short-lived Console grant. */
export interface ConsoleAccessService {
  readonly endpoint: () => DaemonEndpoint | undefined;
  readonly requestGrant: (endpoint: DaemonEndpoint) => Promise<ConsoleGrant>;
}
