import type { QueryClient } from "@tanstack/solid-query";
import { openDaemonNotifications } from "./browserAccess.ts";
import { noteDaemonConnected, noteDaemonRetry, requireDaemonReconnect } from "./connectionState.ts";

const consume = async (
  response: Response,
  client: QueryClient,
  signal: AbortSignal,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("the Daemon notification stream has no body");
  while (!signal.aborted) {
    const next = await reader.read();
    if (next.done) break;
    await client.invalidateQueries();
  }
};

/** Establish a fresh subscription before a manual reconnect may unlock mutations. */
export const reconnectDaemonNotifications = async (client: QueryClient): Promise<void> => {
  const controller = new AbortController();
  const response = await openDaemonNotifications(
    AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
  );
  void consume(response, client, controller.signal).catch(() => requireDaemonReconnect());
};

/** Observe best-effort invalidations. Every notice causes fresh authoritative snapshots. */
export const observeDaemonNotifications = (client: QueryClient): (() => void) => {
  const controller = new AbortController();
  void (async () => {
    for (const delay of [0, 1_000, 2_000]) {
      if (delay > 0) {
        noteDaemonRetry();
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (controller.signal.aborted) return;
      try {
        const response = await openDaemonNotifications(
          AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
        );
        noteDaemonConnected();
        await consume(response, client, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
      }
    }
    requireDaemonReconnect();
  })();
  return () => controller.abort();
};
