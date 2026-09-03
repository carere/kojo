import {
  decodeMutationEnvelope,
  type MutationEnvelope,
} from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { StructuredIdentity } from "@carere/kojo-client-contracts/contexts/shared/models/identity";
import { ProjectStoreError } from "../../project/models/ProjectStoreError.ts";
import type {
  ClientRequestRepository,
  RetainedClientRequest,
} from "../ports/ClientRequestRepository.ts";
import type { OperationRepository } from "../ports/OperationRepository.ts";

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
  readonly #outcomes: OperationRepository | undefined;
  readonly #repository: ClientRequestRepository;

  constructor(options: {
    readonly dataIdentity: string;
    readonly now: () => number;
    readonly outcomes?: OperationRepository;
    readonly repository: ClientRequestRepository;
  }) {
    this.#dataIdentity = options.dataIdentity;
    this.#now = options.now;
    this.#outcomes = options.outcomes;
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

  /** Read the authoritative SQLite outcome. This operation never starts or repeats work. */
  outcome(requestId: string): OperationReceipt | undefined {
    return this.#outcomes?.read(this.#dataIdentity, requestId);
  }

  /** Return a same-content recorded result before a replay can dispatch the domain use case. */
  recorded(request: MutationEnvelope): OperationReceipt | undefined {
    return this.#outcomes?.readExact(request);
  }

  /** Copy an authoritative result reference to the private Host journal. */
  resolved(request: MutationEnvelope): OperationReceipt | undefined {
    const receipt = this.recorded(request);
    if (receipt === undefined) return undefined;
    this.#repository.resolve(request.requestId, {
      resolvedAt: new Date(this.#now()).toISOString(),
      status: receipt.status,
      resultReference: {
        identityVersion: 1,
        kind: "operationOutcome",
        parts: [request.requestId],
      },
      ...(receipt.result === undefined ? {} : { result: receipt.result }),
    });
    return receipt;
  }

  lookup(requestId: string): RetainedClientRequest | undefined {
    return this.#repository.lookup(requestId);
  }

  list(): ReturnType<ClientRequestRepository["list"]> {
    return this.#repository.list();
  }
}
