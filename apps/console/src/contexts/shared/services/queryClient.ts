import { QueryClient } from "@tanstack/solid-query";
import { daemonReadsAllowed, noteDaemonRetry } from "../../daemon/services/connectionState.ts";
import { refused } from "./api.ts";

/** Poll live Console snapshots once per second. */
export const pollMillis = 1_000;

export const daemonPollInterval = (
  query: { readonly state: { readonly fetchFailureCount: number } },
  interval: number | false,
): number | false =>
  query.state.fetchFailureCount > 0 || !daemonReadsAllowed() ? false : interval;

/** Keep the last successful snapshot during a connection failure. Retry twice, after one and two seconds, then require explicit Reconnect. Refusals are not retried. Window focus does not start another read. */
export const consoleQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: (attempt: number, error: Error) => {
          if (refused(error) || !daemonReadsAllowed()) return false;
          if (attempt >= 2) return false;
          noteDaemonRetry();
          return true;
        },
        retryDelay: (attempt: number) => 1_000 * 2 ** attempt,
        refetchOnWindowFocus: false,
        staleTime: 0,
      },
    },
  });
