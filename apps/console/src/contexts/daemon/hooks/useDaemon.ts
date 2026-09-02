import type { DaemonDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/browser";
import { type UseQueryResult, useQuery } from "@tanstack/solid-query";
import { readDaemon } from "../services/browserAccess.ts";

export const useDaemon = (): UseQueryResult<DaemonDocument, Error> =>
  useQuery(() => ({
    queryKey: ["daemon", "details"],
    queryFn: readDaemon,
  }));
