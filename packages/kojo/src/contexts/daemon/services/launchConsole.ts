import { Effect } from "effect";
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

const accessFailure = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError("DAEMON_ACCESS_FAILED", "the Console launch failed", cause);

export const launchConsole = (paths: DaemonPaths, browser: BrowserService, noOpen: boolean) =>
  Effect.gen(function* () {
    const endpoint = yield* Effect.try({
      try: () => readDaemonEndpoint(paths),
      catch: accessFailure,
    });
    if (endpoint === undefined) {
      return yield* Effect.fail(
        new LifecycleError(
          "DAEMON_UNAVAILABLE",
          "the Daemon is not ready; run `kojo daemon status` and start it explicitly if needed",
        ),
      );
    }
    const grant = yield* Effect.tryPromise({
      try: () => requestGrant(endpoint),
      catch: accessFailure,
    });
    if (noOpen) return grant.launchUrl;
    yield* Effect.try({
      try: () => browser.open(grant.launchUrl),
      catch: accessFailure,
    });
    return "Opened the Console from the active Daemon.";
  });
