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
        yield* repository.beginAcquisition(
          {
            ...authority,
            leaseId: "lease-memory",
            kind: "sandbox",
            acquisitionKey: "run-memory/sandbox",
            requestedAt: "2026-09-01T10:00:00.000Z",
            detail: { branch: "kojo/run-memory" },
          },
          {
            providerIdentity: "kojo-resource:lease-memory",
            inspectionLocator: "/fixture/lease-memory.json",
          },
        );
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

  it("rejects a forged retry for an existing acquisition identity", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ResourceLeaseRepository;
        const intent = {
          ...authority,
          leaseId: "lease-memory",
          kind: "sandbox" as const,
          acquisitionKey: "run-memory/sandbox",
          requestedAt: "2026-09-01T10:00:00.000Z",
          detail: { branch: "kojo/run-memory" },
        };
        const allocation = {
          providerIdentity: "kojo-resource:lease-memory",
          inspectionLocator: "/fixture/lease-memory.json",
        };
        const first = yield* repository.beginAcquisition(intent, allocation);
        const retry = yield* repository.beginAcquisition(intent, allocation);
        const forged = yield* repository
          .beginAcquisition(
            { ...intent, runnerInstanceId: "forged-runner" },
            { ...allocation, providerIdentity: "kojo-resource:forged" },
          )
          .pipe(Effect.flip);
        const duplicateKey = yield* repository
          .beginAcquisition({ ...intent, leaseId: "forged-lease" }, allocation)
          .pipe(Effect.flip);
        return { first, retry, forged, duplicateKey };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.retry).toEqual(result.first);
    expect(result.forged.code).toBe("RESOURCE_STATE_CONFLICT");
    expect(result.duplicateKey.code).toBe("RESOURCE_STATE_CONFLICT");
  });

  it("keeps exact Project Runner termination proof immutable", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ResourceLeaseRepository;
        const proof = {
          projectId: authority.projectId,
          priorRunnerInstanceId: authority.runnerInstanceId,
          terminationConfirmedAt: "2026-09-01T10:01:00.000Z",
        };
        yield* repository.confirmRunnerTermination(proof);
        yield* repository.confirmRunnerTermination(proof);
        return yield* repository
          .confirmRunnerTermination({
            ...proof,
            terminationConfirmedAt: "2026-09-01T10:01:01.000Z",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer)),
    );

    expect(result.code).toBe("RESOURCE_STATE_CONFLICT");
  });

  it("accepts only exact same-state lifecycle retries", async () => {
    const conflicts = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ResourceLeaseRepository;
        const create = (leaseId: string, kind: "agent" | "sandbox" | "worktree") =>
          repository.beginAcquisition(
            {
              ...authority,
              leaseId,
              kind,
              acquisitionKey: `${authority.runId}/${leaseId}`,
              requestedAt: "2026-09-01T10:00:00.000Z",
              detail: {},
            },
            {
              providerIdentity: `kojo-resource:${leaseId}`,
              inspectionLocator: `/fixture/${leaseId}.json`,
            },
          );
        yield* create("lease-release", "sandbox");
        yield* repository.confirmAcquired(authority, "lease-release", "2026-09-01T10:00:01.000Z", {
          providerIdentity: "kojo-resource:lease-release",
          locator: "/fixture/worktree",
        });
        yield* repository.beginRelease(authority, "lease-release", "2026-09-01T10:00:02.000Z");
        yield* repository.confirmReleased(
          authority,
          "lease-release",
          "2026-09-01T10:00:03.000Z",
          "exact release",
        );
        yield* repository.confirmReleased(
          authority,
          "lease-release",
          "2026-09-01T10:00:03.000Z",
          "exact release",
        );
        const released = yield* repository
          .confirmReleased(authority, "lease-release", "2026-09-01T10:00:04.000Z", "forged release")
          .pipe(Effect.flip);
        yield* create("lease-preserve", "worktree");
        yield* repository.confirmAcquired(authority, "lease-preserve", "2026-09-01T10:00:01.000Z", {
          providerIdentity: "kojo-resource:lease-preserve",
          locator: "/fixture/worktree",
        });
        yield* repository.preserve(
          authority,
          "lease-preserve",
          "2026-09-01T10:00:05.000Z",
          "dirty",
        );
        yield* repository.preserve(
          authority,
          "lease-preserve",
          "2026-09-01T10:00:05.000Z",
          "dirty",
        );
        const preserved = yield* repository
          .preserve(authority, "lease-preserve", "2026-09-01T10:00:06.000Z", "forged dirty")
          .pipe(Effect.flip);
        return { released, preserved, leases: yield* repository.byRun(authority.runId) };
      }).pipe(Effect.provide(layer)),
    );

    expect(conflicts.released.code).toBe("RESOURCE_STATE_CONFLICT");
    expect(conflicts.preserved.code).toBe("RESOURCE_STATE_CONFLICT");
    expect(conflicts.leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leaseId: "lease-preserve",
          observedAt: "2026-09-01T10:00:05.000Z",
        }),
      ]),
    );
  });
});
