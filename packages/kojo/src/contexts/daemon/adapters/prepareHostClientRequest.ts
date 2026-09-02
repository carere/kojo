import { join } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { HostClientRequestRepository } from "./HostClientRequestRepository.ts";

/** CLI Host composition: retain exact replay bytes locally before any Daemon send. */
export const prepareHostClientRequest = (
  paths: DaemonPaths,
  request: MutationEnvelope,
): HostClientRequestRepository => {
  const repository = new HostClientRequestRepository(
    join(paths.dataRoot, "client-requests"),
    request.dataIdentity,
  );
  repository.prepare(request);
  repository.requireExact(request);
  return repository;
};
