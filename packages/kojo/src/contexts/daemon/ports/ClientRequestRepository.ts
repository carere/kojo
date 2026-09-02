import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";

/** Durable prepared client requests used before a Project mutation is sent. */
export interface ClientRequestRepository {
  readonly prepare: (request: MutationEnvelope) => string;
  readonly lookup: (
    requestId: string,
  ) => { readonly request: MutationEnvelope; readonly body: string } | undefined;
}
