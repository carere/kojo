import type { ProjectSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { readProjects } from "../../daemon/services/browserAccess.ts";

export const useProjects = (): UseQueryResult<ProjectSnapshot, Error> =>
  useQuery(() => ({
    queryKey: ["projects", "snapshot"],
    queryFn: readProjects,
    refetchInterval: (query) => query.state.data?.refreshAfterMillis ?? 1_000,
  }));
