import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonEndpoint } from "../models/Endpoint.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { ConsoleAccessService, ConsoleGrant } from "../ports/ConsoleAccessService.ts";
import { readDaemonEndpoint } from "../services/daemonStatus.ts";

const requestGrant = async (endpoint: DaemonEndpoint): Promise<ConsoleGrant> => {
  const response = await fetch("http://localhost/ui-grants", {
    method: "POST",
    unix: endpoint.socketPath,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new LifecycleError("DAEMON_ACCESS_FAILED", "the Daemon refused a Console launch");
  }
  const grant = (await response.json()) as Partial<ConsoleGrant>;
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

export class HostConsoleAccessService implements ConsoleAccessService {
  readonly #paths: DaemonPaths;

  constructor(paths: DaemonPaths) {
    this.#paths = paths;
  }

  readonly endpoint = (): DaemonEndpoint | undefined => readDaemonEndpoint(this.#paths);
  readonly requestGrant = requestGrant;
}
