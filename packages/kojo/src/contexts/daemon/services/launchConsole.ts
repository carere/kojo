import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonEndpoint } from "../models/Endpoint.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { BrowserService } from "../ports/BrowserService.ts";
import { readDaemonEndpoint } from "./daemonStatus.ts";

interface GrantResponse {
  readonly expiresAt: string;
  readonly launchUrl: string;
}

const requestGrant = async (endpoint: DaemonEndpoint): Promise<GrantResponse> => {
  const response = await fetch("http://localhost/ui-grants", {
    method: "POST",
    unix: endpoint.socketPath,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new LifecycleError("DAEMON_ACCESS_FAILED", "the Daemon refused a Console launch");
  }
  const grant = (await response.json()) as Partial<GrantResponse>;
  if (typeof grant.launchUrl !== "string" || typeof grant.expiresAt !== "string") {
    throw new LifecycleError("DAEMON_ACCESS_FAILED", "the Daemon returned an invalid launch grant");
  }
  const launch = new URL(grant.launchUrl);
  if (
    launch.origin !== endpoint.consoleOrigin ||
    launch.pathname !== "/daemon" ||
    !launch.hash.startsWith("#grant=")
  ) {
    throw new LifecycleError(
      "DAEMON_ACCESS_FAILED",
      "the Daemon returned the wrong Console origin",
    );
  }
  return { expiresAt: grant.expiresAt, launchUrl: grant.launchUrl };
};

export const launchConsole = async (
  paths: DaemonPaths,
  browser: BrowserService,
  noOpen: boolean,
): Promise<string> => {
  const endpoint = readDaemonEndpoint(paths);
  if (endpoint === undefined) {
    throw new LifecycleError(
      "DAEMON_UNAVAILABLE",
      "the Daemon is not ready; run `kojo daemon status` and start it explicitly if needed",
    );
  }
  const grant = await requestGrant(endpoint);
  if (noOpen) return grant.launchUrl;
  browser.open(grant.launchUrl);
  return "Opened the Console from the active Daemon.";
};
