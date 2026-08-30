import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { type Accessor, createSignal } from "solid-js";
import { fetchJson, refused } from "../../shared/services/api.ts";
import { pollMillis } from "../../shared/services/queryClient.ts";
import { beginning, type OccurrenceLine, type OccurrencePageDoc } from "../models/OccurrenceDoc.ts";

/**
 * One phase's tool calls and `exec` invocations — streamed while it runs, listed once it does not.
 *
 * console.md §7 makes this the **only** cursor in the API, and §6 puts the records it returns in the
 * detail panel and nowhere else. Two consequences shape this hook:
 *
 * - **The page is appended, never swapped in.** The cursor means *what you have already been given*,
 *   so a poll that found nothing returns an empty page — and a hook that rendered the last page would
 *   empty the list every idle second. What is on screen is everything this panel has been handed
 *   since it opened.
 * - **It stops when the phase does.** The interval is a function of whether this phase is the run's
 *   in-flight one, which is the same rule the run document polls by: a phase that has exited cannot
 *   grow another occurrence, and asking again for ever would make an open panel cost a request a
 *   second for as long as somebody leaves the tab open.
 *
 * The accumulated rows carry the phase they belong to, so a panel that moves to another phase cannot
 * show the previous one's calls for the width of one request. That is not defensive: the query key
 * changes and the fetch starts before any effect could have cleared a separate signal.
 */

/** What the panel reads: everything handed over so far, and the query behind it. */
export interface OccurrenceStream {
  readonly occurrences: Accessor<ReadonlyArray<OccurrenceLine>>;
  readonly query: UseQueryResult<OccurrencePageDoc, Error>;
}

/** Everything one phase has been given, and where to resume. Kept together so they cannot disagree. */
interface Held {
  readonly phaseId: string;
  readonly rows: ReadonlyArray<OccurrenceLine>;
  readonly cursor: number;
}

const empty: Held = { phaseId: "", rows: [], cursor: beginning };

export const useOccurrences = (options: {
  readonly runId: Accessor<string>;
  readonly phaseId: Accessor<string>;
  /** Whether this phase can have agent activity that a person can inspect. */
  readonly enabled: Accessor<boolean>;
  /** Whether the phase is the one the run is inside right now. */
  readonly live: Accessor<boolean>;
}): OccurrenceStream => {
  const [held, setHeld] = createSignal<Held>(empty);

  const query = useQuery(() => ({
    queryKey: ["occurrences", options.runId(), options.phaseId()],
    enabled: options.enabled(),
    queryFn: async (): Promise<OccurrencePageDoc> => {
      const phaseId = options.phaseId();
      const carried = held();
      const since = carried.phaseId === phaseId ? carried.cursor : beginning;
      const page = await fetchJson<OccurrencePageDoc>(
        `/api/runs/${encodeURIComponent(options.runId())}/phases/${encodeURIComponent(phaseId)}/occurrences?since=${since}`,
      );
      setHeld((previous) =>
        previous.phaseId === phaseId
          ? {
              phaseId,
              rows: [...previous.rows, ...page.occurrences],
              // A poll that found nothing leaves the cursor where it was, exactly as the page does.
              cursor: page.occurrences.length > 0 ? page.cursor : previous.cursor,
            }
          : { phaseId, rows: [...page.occurrences], cursor: page.cursor },
      );
      return page;
    },
    // The same two halves the run document polls by: stop when the phase can grow nothing more, and
    // stop when the server has refused the question rather than failed to answer it.
    refetchInterval: (query: { readonly state: { readonly error: Error | null } }) =>
      options.live() && !refused(query.state.error) ? pollMillis : (false as const),
  }));

  return {
    occurrences: () => (held().phaseId === options.phaseId() ? held().rows : []),
    query,
  };
};
