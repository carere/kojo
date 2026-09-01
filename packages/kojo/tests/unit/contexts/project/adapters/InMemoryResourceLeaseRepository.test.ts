import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { layer } from "../../../../../src/contexts/project/adapters/InMemoryResourceLeaseRepository.ts";
import { ResourceLeaseRepository } from "../../../../../src/contexts/project/ports/ResourceLeaseRepository.ts";

const authority = {
  projectId: "project-memory",
  runId: "run-memory",
  revisionId: "a".repeat(64),
  runnerInstanceId: "runner-memory",
  claimGeneration: 1,
} as const;

describe("in-memory Resource lease repository", () => {
  it("keeps the acquisition identity inspectable after a lost reply", async () => {
    const leases = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ResourceLeaseRepository;
        yield* repository.beginAcquisition({
          ...authority,
          leaseId: "lease-memory",
          kind: "sandbox",
          acquisitionKey: "run-memory/sandbox",
          requestedAt: "2026-09-01T10:00:00.000Z",
          detail: { branch: "kojo/run-memory" },
        });
        return yield* repository.byRun(authority.runId);
      }).pipe(Effect.provide(layer)),
    );

    expect(leases).toEqual([
      expect.objectContaining({
        leaseId: "lease-memory",
        state: "acquisition-intent",
        acquisitionKey: "run-memory/sandbox",
      }),
    ]);
  });
});
