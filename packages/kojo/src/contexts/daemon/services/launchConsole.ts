import { Effect } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { BrowserService } from "../ports/BrowserService.ts";
import type { ConsoleAccessService } from "../ports/ConsoleAccessService.ts";

const accessFailure = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError("DAEMON_ACCESS_FAILED", "the Console launch failed", cause);

export const launchConsole = (
  access: ConsoleAccessService,
  browser: BrowserService,
  noOpen: boolean,
) =>
  Effect.gen(function* () {
    const endpoint = yield* Effect.try({
      try: access.endpoint,
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
      try: () => access.requestGrant(endpoint),
      catch: accessFailure,
    });
    if (noOpen) return grant.launchUrl;
    yield* Effect.try({
      try: () => browser.open(grant.launchUrl),
      catch: accessFailure,
    });
    return "Opened the Console from the active Daemon.";
  });
