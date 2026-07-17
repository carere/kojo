import { queryOptions } from "@tanstack/solid-query";
import { Effect } from "effect";
import { ApiClient, visualizerRuntime } from "../clients/api";

export const healthQueryOptions = () =>
  queryOptions({
    queryKey: ["system", "health"] as const,
    queryFn: async ({ signal }) =>
      await visualizerRuntime.runPromise(
        Effect.gen(function* () {
          const apiClient = yield* ApiClient;
          return yield* apiClient.system.health();
        }),
        { signal },
      ),
    retry: false,
  });
