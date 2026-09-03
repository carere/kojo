import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { RunningDaemon } from "../../../src/contexts/daemon/services/DaemonComposition.ts";

export const sendPreparedMutation = async (
  daemon: RunningDaemon,
  path: string,
  mutation: MutationEnvelope,
): Promise<Response> => {
  const request = (target: string, body: MutationEnvelope): Promise<Response> =>
    fetch(`http://localhost${target}`, {
      unix: daemon.endpoint.socketPath,
      method: target === path ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    } as RequestInit & { readonly unix: string });
  const prepared = await request(`/api/v1/client-requests/${mutation.requestId}`, mutation);
  if (prepared.status !== 201) {
    throw new Error(`request preparation failed: ${await prepared.text()}`);
  }
  return request(path, mutation);
};
