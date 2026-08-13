import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import type { Health } from "../models/Health.ts";
import { fetchJson } from "../services/api.ts";
import { pollMillis } from "../services/queryClient.ts";

/**
 * Where this Console is reading, and whether there is a factory there at all.
 *
 * **Asked once and never polled, unless somebody is waiting on the one field that moves.** Whether a
 * repository has a factory does not change while a Console is open — `kojo ui` measured it before it
 * built a layer, and a `kojo init` run afterwards needs a restart anyway. So the default is a single
 * request.
 *
 * The exception is `runner`. A verdict that is recorded and not yet applied turns on whether
 * anything is alive to apply it, and that answer changes underneath a page: a watcher can be started
 * or killed while a card sits on screen saying which of the two states it is in. The gate card is
 * what passes `live`, and it passes it only while it is holding such a verdict — so the cost is paid
 * exactly when the answer is being read and never otherwise.
 *
 * Both callers share one cache entry, because they are asking one question. The interval belongs to
 * the observer rather than to the key, so the run list's single request is unaffected by a card
 * polling on another route.
 */
export const useHealth = (live: () => boolean = () => false): UseQueryResult<Health, Error> =>
  useQuery(() => ({
    queryKey: ["health"],
    queryFn: () => fetchJson<Health>("/api/health"),
    refetchInterval: live() ? pollMillis : (false as const),
  }));
