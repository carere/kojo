import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import { fetchJson } from "../../shared/services/api.ts";
import { pollMillis } from "../../shared/services/queryClient.ts";
import type { Asking } from "../models/Asking.ts";

/**
 * Every asking this factory has made, polled on the same cadence as the runs.
 *
 * **It is told whether anything is live rather than deciding for itself.** An asking carries no
 * outcome, so this query cannot know whether the factory has stopped; the run list can, and the two
 * must stop together or the *open gate* column would keep costing a request a second after every run
 * had finished.
 *
 * Answered askings come back too, and the filtering happens on the client. The queue view of
 * console.md §3 wants the answered ones, the run list wants only what is still open, and one request
 * serving both is cheaper than two endpoints that can disagree.
 */
export const useAskings = (live: Accessor<boolean>): UseQueryResult<ReadonlyArray<Asking>, Error> =>
  useQuery(() => ({
    queryKey: ["gates"],
    queryFn: () => fetchJson<ReadonlyArray<Asking>>("/api/gates"),
    refetchInterval: live() ? pollMillis : (false as const),
  }));
