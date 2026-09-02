import {
  decodeMutationEnvelope,
  type MutationEnvelope,
} from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { StructuredIdentity } from "@carere/kojo-client-contracts/contexts/shared/models/identity";
import { ProjectStoreError } from "../../project/models/ProjectStoreError.ts";
import type {
  ClientRequestRepository,
  RetainedClientRequest,
} from "../ports/ClientRequestRepository.ts";

const refused = (code: string, message: string): ProjectStoreError =>
  new ProjectStoreError({
    code,
    message,
    status: 409,
    retry: "lookupOriginal",
    remedy: "Prepare and send the same complete mutation envelope.",
  });

/** One Host boundary for prepare, exact validation, resolution, and replay of client mutations. */
export class ClientMutationBoundary {
  readonly #dataIdentity: string;
  readonly #now: () => number;
  readonly #repository: ClientRequestRepository;

  constructor(options: {
    readonly dataIdentity: string;
    readonly now: () => number;
    readonly repository: ClientRequestRepository;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#now = options.now;
    this.#repository = options.repository;
  }

  decode(input: unknown): MutationEnvelope {
    const decoded = decodeMutationEnvelope(input);
    if (!decoded.ok) throw refused("INVALID_CLIENT_REQUEST", "The mutation envelope is invalid.");
    if (decoded.value.dataIdentity !== this.#dataIdentity) {
      throw refused("DATA_IDENTITY_MISMATCH", "The mutation belongs to different Daemon data.");
    }
    return decoded.value;
  }

  prepare(input: unknown): MutationEnvelope {
    const request = this.decode(input);
    this.#repository.prepare(request);
    return request;
  }

  require(input: unknown, operation: string, target: StructuredIdentity): MutationEnvelope {
    const request = this.decode(input);
    if (
      request.operation !== operation ||
      request.target.identityVersion !== target.identityVersion ||
      request.target.kind !== target.kind ||
      request.target.parts.length !== target.parts.length ||
      request.target.parts.some((part, index) => part !== target.parts[index])
    ) {
      throw refused(
        "CLIENT_REQUEST_TARGET_MISMATCH",
        "The prepared mutation does not match the selected operation and target.",
      );
    }
    this.#repository.requireExact(request);
    return request;
  }

  requireKind(input: unknown, operation: string, targetKind: string): MutationEnvelope {
    const request = this.decode(input);
    if (request.operation !== operation || request.target.kind !== targetKind) {
      throw refused(
        "CLIENT_REQUEST_TARGET_MISMATCH",
        "The prepared mutation does not match the selected operation and target kind.",
      );
    }
    this.#repository.requireExact(request);
    return request;
  }

  resolve(requestId: string, status: "accepted" | "committed" = "committed"): void {
    this.#repository.resolve(requestId, {
      resolvedAt: new Date(this.#now()).toISOString(),
      status,
      resultReference: {
        identityVersion: 1,
        kind: "clientRequestResult",
        parts: [requestId],
      },
    });
  }

  lookup(requestId: string): RetainedClientRequest | undefined {
    return this.#repository.lookup(requestId);
  }

  list(): ReturnType<ClientRequestRepository["list"]> {
    return this.#repository.list();
  }
}
