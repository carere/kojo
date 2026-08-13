import { QueryClient } from "@tanstack/solid-query";
import { refused } from "./api.ts";

/** How often a live Console asks again. One second, per console.md §7. */
export const pollMillis = 1_000;

/**
 * The Console's server cache.
 *
 * Two defaults here are decisions rather than tuning, and both come out of console.md §10's rule
 * that an unreachable API must never blank the view:
 *
 * - **Retry forever, with a capped backoff — but only what is worth retrying.** A bounded retry ends
 *   in an error state, and an error state is a Console that has given up on a `kojo ui` somebody is
 *   about to restart. Retrying without end is what makes *keep the last data on screen, show a
 *   retrying banner* true rather than true for thirty seconds. The cap keeps a long outage from
 *   backing off into minutes. **A refusal is exempt**: a `404 no-such-run` is the server answering,
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
        retry: (_attempt: number, error: Error) => !refused(error),
        retryDelay: (attempt: number) => Math.min(500 * 2 ** attempt, 5_000),
        refetchOnWindowFocus: false,
        staleTime: 0,
      },
    },
  });
