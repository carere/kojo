import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import type { StructuredIdentity } from "@carere/kojo-client-contracts/contexts/shared/models/identity";

export interface ClientRequestResolution {
  readonly resolvedAt: string;
  readonly status: "accepted" | "committed";
  readonly resultReference: StructuredIdentity;
  /** The private, exact result used by Host-only replay after the Daemon is unavailable. */
  readonly result?: JsonValue;
}

export interface RetainedClientRequest {
  readonly request?: MutationEnvelope;
  readonly requestId: string;
  readonly dataIdentity: string;
  readonly body?: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly subject: {
    readonly operation: string;
    readonly targetKind: string;
  };
  readonly resolution?: ClientRequestResolution;
}

/** Durable prepared client requests used before any domain mutation is sent. */
export interface ClientRequestRepository {
  readonly prepare: (request: MutationEnvelope) => string;
  readonly requireExact: (request: MutationEnvelope) => string;
  readonly lookup: (requestId: string) => RetainedClientRequest | undefined;
  readonly resolve: (requestId: string, resolution: ClientRequestResolution) => void;
  readonly compactResolved: () => void;
  readonly list: () => ReadonlyArray<
    RetainedClientRequest & {
      readonly retainedAt: string;
    }
  >;
}
