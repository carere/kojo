import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import { describe, expect, it } from "vitest";
import type {
  ClientRequestRepository,
  ClientRequestResolution,
  RetainedClientRequest,
} from "../../../../../src/contexts/daemon/ports/ClientRequestRepository.ts";
import { ClientMutationBoundary } from "../../../../../src/contexts/daemon/services/ClientMutationBoundary.ts";

class InMemoryClientRequestRepository implements ClientRequestRepository {
  readonly #requests = new Map<string, RetainedClientRequest>();

  prepare(request: MutationEnvelope): string {
    const body = JSON.stringify(request);
    const existing = this.#requests.get(request.requestId);
    if (existing !== undefined && existing.body !== body) throw new Error("request conflict");
    this.#requests.set(request.requestId, {
      request,
      requestId: request.requestId,
      dataIdentity: request.dataIdentity,
      body,
      contentHash: body,
      createdAt: "2026-09-02T00:00:00.000Z",
      subject: { operation: request.operation, targetKind: request.target.kind },
    });
    return body;
  }

  requireExact(request: MutationEnvelope): string {
    const retained = this.#requests.get(request.requestId);
    const body = JSON.stringify(request);
    if (retained?.body !== body) throw new Error("different request content");
    return body;
  }

  lookup(requestId: string): RetainedClientRequest | undefined {
    return this.#requests.get(requestId);
  }

  resolve(requestId: string, resolution: ClientRequestResolution): void {
    const retained = this.#requests.get(requestId);
    if (retained === undefined) throw new Error("request not found");
    this.#requests.set(requestId, { ...retained, resolution });
  }

  compactResolved(): void {}

  list(): ReadonlyArray<RetainedClientRequest & { readonly retainedAt: string }> {
    return [...this.#requests.values()].map((request) => ({
      ...request,
      retainedAt: request.createdAt,
    }));
  }
}

const request: MutationEnvelope = {
  mutationVersion: 1,
  requestId: "request-exact",
  dataIdentity: "data-one",
  operation: "startWorkflow",
  target: { identityVersion: 1, kind: "workflow", parts: ["project-one", "review"] },
  arguments: { payload: { request: "change" } },
  preconditions: { revision: "revision-one" },
};

describe("ClientMutationBoundary", () => {
  it("refuses replacement operation, target, arguments, or preconditions for one prepared ID", () => {
    const boundary = new ClientMutationBoundary({
      dataIdentity: request.dataIdentity,
      now: () => Date.parse("2026-09-02T00:00:00.000Z"),
      repository: new InMemoryClientRequestRepository(),
    });
    boundary.prepare(request);
    expect(boundary.requireKind(request, "startWorkflow", "workflow")).toEqual(request);

    for (const replacement of [
      { ...request, operation: "stopWorkflow" },
      { ...request, target: { ...request.target, parts: ["project-two", "review"] } },
      { ...request, arguments: { payload: { request: "replacement" } } },
      { ...request, preconditions: { revision: "revision-two" } },
    ]) {
      expect(() => boundary.requireKind(replacement, replacement.operation, "workflow")).toThrow(
        /different request content/,
      );
    }
  });
});
