import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { readRuns } from "../../daemon/services/browserAccess.ts";
import { fetchJson } from "../../shared/services/api.ts";
import { pollMillis } from "../../shared/services/queryClient.ts";
import { allSettled, type RunLine } from "../models/RunLine.ts";

/**
 * Every run, polled whole while any of them can still move.
 *
 * **The interval is a function of the query's own data**, which is what lets the rule be stated once
 * and be self-contained: nothing outside has to work out whether the factory is busy and feed the
 * answer back in. When every run has reached a terminal outcome the interval is `false`, and the
 * Console stops asking for good — a finished run left open in a tab costs one request in total.
 *
 * The list is fetched whole rather than by cursor. console.md §7 confines the cursor to occurrences,
 * which are genuinely unbounded; a factory's run list is not, and replacing it wholesale removes
 * every merge concern a partial update would create.
 */
export const useRuns = (): UseQueryResult<ReadonlyArray<RunLine>, Error> =>
  useQuery(() => ({
    queryKey: ["runs"],
    queryFn: async () => {
      try {
        const snapshot = await readRuns();
        return snapshot.runs.map(
          (run): RunLine => ({
            run: {
              runId: run.runId,
              workflow: run.workflowName,
              startedAt: Date.parse(run.startedAt ?? run.admittedAt),
            },
            ...(run.state === "succeeded" || run.state === "failed" ? { outcome: run.state } : {}),
          }),
        );
      } catch {
        return fetchJson<ReadonlyArray<RunLine>>("/api/runs");
      }
    },
    refetchInterval: (query: {
      readonly state: { readonly data: ReadonlyArray<RunLine> | undefined };
    }) => (allSettled(query.state.data ?? []) ? (false as const) : pollMillis),
  }));
