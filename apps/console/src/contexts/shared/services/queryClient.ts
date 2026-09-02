import { QueryClient } from "@tanstack/solid-query";
import { daemonReadsAllowed, noteDaemonRetry } from "../../daemon/services/connectionState.ts";
import { refused } from "./api.ts";

/** How often a live Console asks again. One second, per console.md §7. */
export const pollMillis = 1_000;

/**
 * The Console's Daemon API cache.
 *
 * Two defaults here are decisions rather than tuning, and both come out of console.md §10's rule
 * that an unreachable API must never blank the view:
 *
 * - **Retry at most twice, after one and two seconds.** Together with the five-second request
 *   timeout, the complete attempt stays below the accepted twenty-second reconnect bound. A
 *   bounded failure enters explicit Reconnect state and disables mutations. **A refusal is
 *   exempt**: a `404 no-such-run` is the server answering,
 *   and asking again for a run that does not exist can only ever produce the same answer more
 *   slowly. Retrying it turns a mistyped id into a permanent *Loading…* under a retrying banner,
 *   which blames the API for a typo.
 * - **No refetch on window focus.** The poll rule says a finished run costs nothing to leave open,
 *   and a refetch fired by clicking back into the tab would quietly undo that.
 *
 * Failed fetches keep the last successful data: `data` is only replaced by a success, so the table
 * on screen survives every failure below it.
 */
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
