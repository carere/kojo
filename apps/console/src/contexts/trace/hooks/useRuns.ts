import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { readRuns } from "../../daemon/services/browserAccess.ts";
import { daemonPollInterval, pollMillis } from "../../shared/services/queryClient.ts";
import { allSettled, type RunLine } from "../models/RunLine.ts";

/**
 * Every run, polled whole while any of them can still move.
 *
 * **The interval is a function of the query's own data**, which is what lets the rule be stated once
 * and be self-contained: nothing outside has to work out whether the factory is busy and feed the
 * answer back in. When every run has reached a terminal outcome the interval is `false`, and the
 * Console stops asking for good — a finished run left open in a tab costs one request in total.
 *
 * The list is fetched whole from the authenticated Daemon API. Replacing it removes every merge
 * concern a partial update would create.
 */
export const useRuns = (): UseQueryResult<ReadonlyArray<RunLine>, Error> =>
  useQuery(() => ({
    queryKey: ["runs"],
    queryFn: async () =>
      (await readRuns()).runs.map(
        (run): RunLine => ({
          run: {
            runId: run.runId,
            workflow: run.workflowName,
            startedAt: Date.parse(run.startedAt ?? run.admittedAt),
          },
          executionState: run.state,
          ...(run.queueReason === undefined ? {} : { queueReason: run.queueReason }),
          ...(run.state === "succeeded" || run.state === "failed" || run.state === "cancelled"
            ? { outcome: run.state }
            : {}),
        }),
      ),
    refetchInterval: (query: {
      readonly state: {
        readonly data: ReadonlyArray<RunLine> | undefined;
        readonly fetchFailureCount: number;
      };
    }) => daemonPollInterval(query, allSettled(query.state.data ?? []) ? false : pollMillis),
  }));
