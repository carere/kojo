import type { WorkflowSnapshot } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { readWorkflows } from "../../daemon/services/browserAccess.ts";
import { daemonPollInterval } from "../../shared/services/queryClient.ts";

export const useWorkflows = (projectId: string): UseQueryResult<WorkflowSnapshot, Error> =>
  useQuery(() => ({
    queryKey: ["projects", projectId, "workflows"],
    queryFn: () => readWorkflows(projectId),
    refetchInterval: (query) =>
      daemonPollInterval(query, query.state.data?.refreshAfterMillis ?? 1_000),
  }));
